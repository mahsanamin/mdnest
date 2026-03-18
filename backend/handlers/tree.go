package handlers

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type TreeHandler struct {
	notesDir string
}

type TreeNode struct {
	Name     string      `json:"name"`
	Type     string      `json:"type"`
	Path     string      `json:"path,omitempty"`
	Children []*TreeNode `json:"children,omitempty"`
}

func NewTreeHandler(notesDir string) *TreeHandler {
	return &TreeHandler{notesDir: notesDir}
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(root)
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
