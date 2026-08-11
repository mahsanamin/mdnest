package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"path"
	"sort"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

type TreeHandler struct {
	store      storage.Storage
	grantStore store.GrantStore // nil in single mode
	groupStore store.GroupStore // nil in single mode or when groups are disabled
}

type TreeNode struct {
	Name     string      `json:"name"`
	Type     string      `json:"type"`
	Path     string      `json:"path,omitempty"`
	Children []*TreeNode `json:"children,omitempty"`
}

func NewTreeHandler(store storage.Storage, grantStore store.GrantStore, groupStore store.GroupStore) *TreeHandler {
	return &TreeHandler{store: store, grantStore: grantStore, groupStore: groupStore}
}

// GetTree handles GET /api/tree?ns=...
func (h *TreeHandler) GetTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()
	ns := RequireNamespaceStore(ctx, h.store, w, r)
	if ns == "" {
		return
	}

	root, err := buildTree(ctx, h.store, ns, "")
	if err != nil {
		http.Error(w, `{"error":"failed to read directory tree"}`, http.StatusInternalServerError)
		return
	}
	root.Name = "root"

	// In multi mode, filter tree to only show paths the user has access to
	if h.grantStore != nil {
		uc := middleware.UserFromContext(r.Context())
		if uc != nil && uc.Role != "admin" {
			grants, _ := h.grantStore.GetGrantsForUser(uc.ID)
			var nsGrants []store.Grant
			for _, g := range grants {
				if g.Namespace == ns {
					nsGrants = append(nsGrants, g)
				}
			}
			// Include grants inherited from the user's groups, otherwise a user
			// who can reach the namespace only through a group would see the
			// namespace but an empty tree.
			if h.groupStore != nil {
				if groupGrants, err := h.groupStore.MemberGroupGrants(uc.ID, uc.Groups, ns); err == nil {
					for _, g := range groupGrants {
						nsGrants = append(nsGrants, store.Grant{Namespace: ns, Path: g.Path, Permission: g.Permission})
					}
				}
			}
			root = filterTreeByGrants(root, nsGrants)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(root)
}

// filterTreeByGrants removes tree nodes the user doesn't have access to.
// A grant on "/" means full access. A grant on "/docs" shows only docs and its children.
func filterTreeByGrants(root *TreeNode, grants []store.Grant) *TreeNode {
	// Check if user has root access
	for _, g := range grants {
		if g.Path == "/" {
			return root // full namespace access
		}
	}

	// Build set of granted paths
	grantPaths := make([]string, 0, len(grants))
	for _, g := range grants {
		p := g.Path
		if strings.HasPrefix(p, "/") {
			p = p[1:]
		}
		grantPaths = append(grantPaths, p)
	}

	filtered := filterNode(root, "", grantPaths)
	if filtered == nil {
		return &TreeNode{Name: "root", Type: "folder", Children: []*TreeNode{}}
	}
	return filtered
}

// filterNode recursively filters a tree node. It keeps:
// - nodes whose path is inside a granted path (e.g. grant="/docs", node="docs/readme.md")
// - ancestor folders that are on the path TO a granted directory (e.g. grant="/docs/sub", keep "docs" folder)
func filterNode(node *TreeNode, currentPath string, grantPaths []string) *TreeNode {
	nodePath := node.Path
	if nodePath == "" {
		nodePath = currentPath
	}

	// Check if this node is directly covered by a grant
	if isPathCovered(nodePath, grantPaths) {
		return node // include this node and all its children
	}

	// For folders, check if any grant is INSIDE this folder (ancestor case)
	if node.Type == "folder" && node.Children != nil {
		var filteredChildren []*TreeNode
		for _, child := range node.Children {
			filtered := filterNode(child, child.Path, grantPaths)
			if filtered != nil {
				filteredChildren = append(filteredChildren, filtered)
			}
		}
		if len(filteredChildren) > 0 {
			return &TreeNode{
				Name:     node.Name,
				Type:     node.Type,
				Path:     node.Path,
				Children: filteredChildren,
			}
		}
	}

	return nil
}

// isPathCovered returns true if nodePath falls under any grantPath.
func isPathCovered(nodePath string, grantPaths []string) bool {
	for _, gp := range grantPaths {
		if gp == "" {
			continue
		}
		// Exact match
		if nodePath == gp {
			return true
		}
		// Node is inside the grant (e.g. grant="docs", node="docs/readme.md")
		if strings.HasPrefix(nodePath, gp+"/") {
			return true
		}
	}
	return false
}

// File extensions shown in the tree — markdown + a few common text formats.
var textExtensions = map[string]bool{
	".md": true, ".markdown": true,
	".txt": true,
	".json": true,
	".sql": true,
	".csv": true,
	".yaml": true, ".yml": true,
}

func isTextFileExt(ext string) bool {
	return textExtensions[ext]
}

func buildTree(ctx context.Context, stg storage.Storage, ns, relPath string) (*TreeNode, error) {
	entries, err := stg.ReadDir(ctx, ns, relPath)
	if err != nil {
		return nil, err
	}

	name := ""
	if relPath != "" {
		name = relPath[strings.LastIndex(relPath, "/")+1:]
	}
	node := &TreeNode{
		Name:     name,
		Type:     "folder",
		Path:     relPath,
		Children: make([]*TreeNode, 0),
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})

	for _, entry := range entries {
		name := entry.Name
		if strings.HasPrefix(name, ".") {
			continue
		}

		childRelPath := name
		if relPath != "" {
			childRelPath = relPath + "/" + name
		}

		if entry.IsDir {
			child, err := buildTree(ctx, stg, ns, childRelPath)
			if err != nil {
				continue
			}
			node.Children = append(node.Children, child)
		} else {
			// Show text-based files only — skip binaries, images, huge files
			ext := strings.ToLower(path.Ext(name))
			if !isTextFileExt(ext) {
				continue
			}
			// Skip files > 5MB to prevent huge files from killing the server
			if entry.Size > 5*1024*1024 {
				continue
			}
			node.Children = append(node.Children, &TreeNode{
				Name: name,
				Type: "file",
				Path: childRelPath,
			})
		}
	}

	return node, nil
}
