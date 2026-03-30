package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

type TreeHandler struct {
	notesDir   string
	grantStore store.GrantStore // nil in single mode
}

type TreeNode struct {
	Name     string      `json:"name"`
	Type     string      `json:"type"`
	Path     string      `json:"path,omitempty"`
	Children []*TreeNode `json:"children,omitempty"`
}

func NewTreeHandler(notesDir string, grantStore store.GrantStore) *TreeHandler {
	return &TreeHandler{notesDir: notesDir, grantStore: grantStore}
}

// GetTree handles GET /api/tree?ns=...
func (h *TreeHandler) GetTree(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	nsDir := RequireNamespace(h.notesDir, w, r)
	if nsDir == "" {
		return
	}

	root, err := buildTree(nsDir, "")
	if err != nil {
		http.Error(w, `{"error":"failed to read directory tree"}`, http.StatusInternalServerError)
		return
	}
	root.Name = "root"

	// In multi mode, filter tree to only show paths the user has access to
	if h.grantStore != nil {
		uc := middleware.UserFromContext(r.Context())
		if uc != nil && uc.Role != "admin" {
			ns := r.URL.Query().Get("ns")
			grants, _ := h.grantStore.GetGrantsForUser(uc.ID)
			var nsGrants []store.Grant
			for _, g := range grants {
				if g.Namespace == ns {
					nsGrants = append(nsGrants, g)
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

func buildTree(dirPath, relativePath string) (*TreeNode, error) {
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	node := &TreeNode{
		Name:     filepath.Base(dirPath),
		Type:     "folder",
		Path:     relativePath,
		Children: make([]*TreeNode, 0),
	}

	sort.Slice(entries, func(i, j int) bool {
		iDir := entries[i].IsDir()
		jDir := entries[j].IsDir()
		if iDir != jDir {
			return iDir
		}
		return strings.ToLower(entries[i].Name()) < strings.ToLower(entries[j].Name())
	})

	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}

		childRelPath := name
		if relativePath != "" {
			childRelPath = relativePath + "/" + name
		}

		if entry.IsDir() {
			child, err := buildTree(filepath.Join(dirPath, name), childRelPath)
			if err != nil {
				continue
			}
			node.Children = append(node.Children, child)
		} else {
			node.Children = append(node.Children, &TreeNode{
				Name: name,
				Type: "file",
				Path: childRelPath,
			})
		}
	}

	return node, nil
}
