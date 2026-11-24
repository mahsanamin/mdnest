package handlers

import (
	"context"
	"os"
	"path"
	"path/filepath"
	"sort"
)

// hiddenRoot only appends trusted, fixed internal names after checking the
// namespace with SafePath. Neither internal folder may be a symlink, including
// a link to another location inside the namespace. Request paths still cannot
// name .mdnest through SafePath or SafeRelPath.
func (h *PagesHandler) hiddenRoot(ns string) string {
	if h.cfg.NotesDir == "" || !ValidNamespaceName(ns) {
		return ""
	}
	root := SafePath(h.cfg.NotesDir, ns)
	if root == "" {
		return ""
	}
	for _, name := range []string{".mdnest", "pages"} {
		root = filepath.Join(root, name)
		fi, err := os.Lstat(root)
		if err != nil && !os.IsNotExist(err) {
			return ""
		}
		if err == nil && (!fi.IsDir() || fi.Mode()&os.ModeSymlink != 0) {
			return ""
		}
	}
	return root
}

func (h *PagesHandler) externalRoot(ns string) string {
	if !ValidNamespaceName(ns) || h.cfg.Dir == "" {
		return ""
	}
	return SafePath(h.cfg.Dir, ns)
}

// pageStorePath also refuses links in a final component. SafePath checks the
// parent chain; an archive restored by another tool must not redirect a file.
func pageStorePath(root, rel string) string {
	if root == "" {
		return ""
	}
	p := SafePath(root, rel)
	if p == "" {
		return ""
	}
	if fi, err := os.Lstat(p); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return ""
	}
	return p
}

func (h *PagesHandler) readRoot(ns, id string) string {
	if !ValidNamespaceName(ns) || !ValidPageID(id) {
		return ""
	}
	hidden := h.hiddenRoot(ns)
	if p := pageStorePath(hidden, path.Join(pagesMetaDir, id+".json")); p != "" {
		if fi, err := os.Stat(p); err == nil && fi.Mode().IsRegular() {
			return hidden
		}
	}
	return h.externalRoot(ns)
}

// storedIDs merges both stores, once per id. readRoot decides which copy wins.
func (h *PagesHandler) storedIDs(ns string) []string {
	seen := map[string]bool{}
	for _, root := range []string{h.hiddenRoot(ns), h.externalRoot(ns)} {
		if root == "" {
			continue
		}
		entries, _ := os.ReadDir(root)
		for _, e := range entries {
			if e.IsDir() && ValidPageID(e.Name()) {
				seen[e.Name()] = true
			}
		}
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// removeHidden uses storage for deletions so the git backend records the
// namespace as dirty even when an unlinked page has no handle to remove.
func (h *PagesHandler) removeHidden(ns, id string) bool {
	root := h.hiddenRoot(ns)
	dir := pageStorePath(root, id)
	meta := pageStorePath(root, path.Join(pagesMetaDir, id+".json"))
	found := false
	for _, p := range []string{dir, meta} {
		if p == "" {
			continue
		}
		if _, err := os.Lstat(p); err == nil {
			found = true
		}
	}
	if dir != "" {
		_ = h.store.RemoveAll(context.Background(), ns, path.Join(".mdnest/pages", id))
	}
	if meta != "" {
		_ = h.store.Remove(context.Background(), ns, path.Join(".mdnest/pages", pagesMetaDir, id+".json"))
	}
	return found
}
