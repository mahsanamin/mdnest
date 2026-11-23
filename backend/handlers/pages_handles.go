package handlers

// Page handles: how a page lives in the notes tree.
//
// A page shows in a namespace as one small note, <name>.page.md, anywhere in
// the tree. It holds only front matter:
//
//	---
//	page: <id>
//	title: "Q3 report"
//	author: "ana"
//	published: 2026-11-20T10:00:00Z
//	---
//
//	HTML page, open it in mdnest.
//
// The page's files are stored by id (PAGES_DIR/<ns>/<id>), never in the notes
// tree. Every permission check is on the HANDLE's path, with the notes'
// own rules: reading the handle lets you view the page, writing it lets you
// publish over it. Moving or renaming the handle is a normal note move and
// needs nothing here, because the page goes wherever its handle goes.
// Copying a handle gives the destination's readers the page, the same as
// copying any note they could read; the id cannot be guessed.
//
// Deleting a handle (DELETE /api/note on it or on a folder holding it) also
// deletes the page, unless another *.page.md in the namespace still names the
// same id (DeleteHook). A handle removed another way (git-sync, the disk)
// leaves the page unlinked: listed for namespace-root writers, never deleted
// on its own.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// PageHandleSuffix ends every handle file name.
const PageHandleSuffix = ".page.md"

const maxHandleSize = 64 << 10

// IsPageHandlePath reports whether a namespace-relative path names a handle
// file: <name>.page.md with a non-empty name.
func IsPageHandlePath(p string) bool {
	base := path.Base(p)
	return strings.HasSuffix(base, PageHandleSuffix) && len(base) > len(PageHandleSuffix)
}

// ParsePageHandle returns the page id a handle names. isHandle is false when
// the file has no `page:` key in its front matter (then it is an ordinary
// note that happens to end in .page.md). The id is not validated here.
func ParsePageHandle(content string) (id string, isHandle bool) {
	fm, _, ok := splitFrontMatter(content)
	if !ok {
		return "", false
	}
	v, ok := frontMatterValue(fm, "page")
	if !ok {
		return "", false
	}
	return strings.TrimSpace(v), true
}

// pageHandleContent is what publish writes to the handle. Values are JSON
// strings, which are valid YAML double-quoted scalars, so a title can hold
// any character without breaking the front matter.
func pageHandleContent(id string, m PageMeta) string {
	q := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	return fmt.Sprintf("---\npage: %s\ntitle: %s\nauthor: %s\npublished: %s\n---\n\nHTML page, open it in mdnest.\n",
		id, q(m.Title), q(m.Author), m.PublishedAt)
}

// Messages for a handle whose page is not here. A handle moved or copied from
// another namespace keeps an id that this namespace does not have.
const (
	errPageOtherNamespace = "this page was published in another namespace: publish it again here"
	errPageFilesMissing   = "this page's files are missing: publish it again here"
)

// handleAt reads the handle at relPath. It writes the error and returns
// ok=false when the path is not a handle, does not exist, or its page is not
// stored in this namespace.
func (h *PagesHandler) handleAt(ctx context.Context, w http.ResponseWriter, ns, relPath string) (string, *PageMeta, bool) {
	data, err := h.store.ReadFile(ctx, ns, relPath)
	if err != nil {
		if errors.Is(err, storage.ErrNotExist) {
			pagesError(w, http.StatusNotFound, "page not found")
		} else {
			pagesError(w, http.StatusInternalServerError, "failed to read the page")
		}
		return "", nil, false
	}
	if len(data) > maxHandleSize {
		pagesError(w, http.StatusBadRequest, "not a page handle")
		return "", nil, false
	}
	id, isHandle := ParsePageHandle(string(data))
	if !isHandle {
		pagesError(w, http.StatusBadRequest, "not a page handle (no page: key in its front matter)")
		return "", nil, false
	}
	if !ValidPageID(id) {
		pagesError(w, http.StatusNotFound, errPageFilesMissing)
		return "", nil, false
	}
	m, err := h.readMeta(ns, id)
	if err != nil {
		if h.storedInOtherNamespace(ns, id) {
			pagesError(w, http.StatusNotFound, errPageOtherNamespace)
		} else {
			pagesError(w, http.StatusNotFound, errPageFilesMissing)
		}
		return "", nil, false
	}
	m.Path = relPath
	return id, m, true
}

// storedInOtherNamespace reports whether another namespace holds this id. It
// only says which error to show; it never serves anything across namespaces.
func (h *PagesHandler) storedInOtherNamespace(ns, id string) bool {
	entries, _ := os.ReadDir(h.cfg.Dir)
	for _, e := range entries {
		if !e.IsDir() || e.Name() == ns || !ValidNamespaceName(e.Name()) {
			continue
		}
		if p := h.metaPath(e.Name(), id); p != "" {
			if _, err := os.Stat(p); err == nil {
				return true
			}
		}
	}
	return false
}

// handleRef is one handle found in a namespace.
type handleRef struct {
	path string
	id   string
}

// handlesIn lists every handle in the namespace (dot folders skipped, as the
// tree skips them). Only *.page.md files are read.
func (h *PagesHandler) handlesIn(ctx context.Context, ns, root string) []handleRef {
	var out []handleRef
	h.store.Walk(ctx, ns, root, func(rel string, info storage.FileInfo) error {
		base := path.Base(rel)
		if rel != "." && rel != root && strings.HasPrefix(base, ".") {
			if info.IsDir {
				return storage.SkipDir
			}
			return nil
		}
		if info.IsDir || info.IsSymlink || !IsPageHandlePath(rel) || info.Size > maxHandleSize {
			return nil
		}
		data, err := h.store.ReadFile(ctx, ns, rel)
		if err != nil {
			return nil
		}
		if id, ok := ParsePageHandle(string(data)); ok && ValidPageID(id) {
			out = append(out, handleRef{path: rel, id: id})
		}
		return nil
	})
	return out
}

// requireHandlePath resolves ?ns= and ?path=, which must name a handle file.
func (h *PagesHandler) requireHandlePath(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return "", "", false
	}
	rel, ok := SafeRelPath(r.URL.Query().Get("path"))
	if !ok || !IsPageHandlePath(rel) {
		pagesError(w, http.StatusBadRequest, "path must name a page handle, ending in "+PageHandleSuffix)
		return "", "", false
	}
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, ".") {
			pagesError(w, http.StatusBadRequest, "invalid path")
			return "", "", false
		}
	}
	return ns, rel, true
}

func (h *PagesHandler) canReadPath(r *http.Request, ns, rel string) bool {
	return h.perms == nil || h.perms.CheckRead(r, ns, "/"+rel)
}

func (h *PagesHandler) canWritePath(r *http.Request, ns, rel string) bool {
	return h.perms == nil || h.perms.CheckWrite(r, ns, "/"+rel)
}

// Handle serves /api/pages: GET lists, PUT (or POST) publishes, DELETE
// removes a handle and its page.
func (h *PagesHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.handleList(w, r)
	case http.MethodPut, http.MethodPost:
		h.handlePublish(w, r)
	case http.MethodDelete:
		h.handleDelete(w, r)
	default:
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// handleList serves GET /api/pages?ns=[&q=][&format=tsv]: every handle in the
// namespace the caller can read, and, for writers of the namespace root, the
// pages no handle points to any more (unlinked).
func (h *PagesHandler) handleList(w http.ResponseWriter, r *http.Request) {
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return
	}
	ctx := r.Context()
	terms := strings.Fields(strings.ToLower(r.URL.Query().Get("q")))
	match := func(m *PageMeta) bool {
		hay := strings.ToLower(m.Title + " " + m.Path + " " + m.Text)
		for _, t := range terms {
			if !strings.Contains(hay, t) {
				return false
			}
		}
		return true
	}
	canRead := func(string) bool { return true }
	if h.perms != nil {
		canRead = h.perms.ReadFilter(r, ns)
	}
	all := h.handlesIn(ctx, ns, "")
	linked := map[string]bool{}
	pages := []PageMeta{}
	for _, ref := range all {
		linked[ref.id] = true
		if !canRead(ref.path) {
			continue
		}
		m, err := h.readMeta(ns, ref.id)
		if err != nil {
			// A handle whose page is not here (moved from another
			// namespace, or hand-edited): listed, so it can be found.
			m = &PageMeta{ID: ref.id, Title: strings.TrimSuffix(path.Base(ref.path), PageHandleSuffix)}
			m.Missing = true
		}
		m.Path = ref.path
		if !match(m) {
			continue
		}
		m.Text = ""
		pages = append(pages, *m)
	}
	sort.Slice(pages, func(i, j int) bool {
		if pages[i].PublishedAt != pages[j].PublishedAt {
			return pages[i].PublishedAt > pages[j].PublishedAt
		}
		return pages[i].Path < pages[j].Path
	})

	if r.URL.Query().Get("format") == "tsv" {
		// One page per line for the CLI, which renders it in awk:
		// path, title, author, publishedAt, files, bytes. Every field is
		// cleaned of control characters.
		w.Header().Set("Content-Type", "text/tab-separated-values; charset=utf-8")
		for _, p := range pages {
			fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%d\n", plainField(p.Path), plainField(p.Title), plainField(p.Author), plainField(p.PublishedAt), p.Files, p.Bytes)
		}
		return
	}
	resp := map[string]any{"pages": pages}
	if h.perms == nil || h.perms.CheckWrite(r, ns, "/") {
		resp["unlinked"] = h.unlinked(ns, linked)
	}
	pagesJSON(w, http.StatusOK, resp)
}

// unlinked lists the stored pages of a namespace that no handle names.
func (h *PagesHandler) unlinked(ns string, linked map[string]bool) []PageMeta {
	out := []PageMeta{}
	dir := h.nsDir(ns)
	if dir == "" {
		return out
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if !e.IsDir() || !ValidPageID(e.Name()) || linked[e.Name()] {
			continue
		}
		m, err := h.readMeta(ns, e.Name())
		if err != nil {
			m = &PageMeta{ID: e.Name(), Title: e.Name()}
		}
		m.Text = ""
		out = append(out, *m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].PublishedAt > out[j].PublishedAt })
	return out
}

// HandleUnlinked serves DELETE /api/pages/unlinked?ns=&id=: removes a stored
// page that no handle names. Write on the namespace root only.
func (h *PagesHandler) HandleUnlinked(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns := RequireNamespaceStore(r.Context(), h.store, w, r)
	if ns == "" {
		return
	}
	if h.perms != nil && !h.perms.CheckWrite(r, ns, "/") {
		middleware.DenyJSON(w)
		return
	}
	id := r.URL.Query().Get("id")
	if !ValidPageID(id) {
		pagesError(w, http.StatusBadRequest, "invalid page id")
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ref := range h.handlesIn(r.Context(), ns, "") {
		if ref.id == id {
			pagesError(w, http.StatusConflict, "a handle still points to this page: "+ref.path)
			return
		}
	}
	if !h.removeStored(ns, id) {
		pagesError(w, http.StatusNotFound, "page not found")
		return
	}
	pagesJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// removeStored deletes a page's files and details. Reports whether there was
// anything to delete. The caller holds h.mu.
func (h *PagesHandler) removeStored(ns, id string) bool {
	dir, meta := h.pageDir(ns, id), h.metaPath(ns, id)
	if dir == "" || meta == "" {
		return false
	}
	_, dErr := os.Stat(dir)
	_, mErr := os.Stat(meta)
	os.Remove(meta)
	os.RemoveAll(dir)
	return dErr == nil || mErr == nil
}

// collectIfUnreferenced deletes each page that no handle in the namespace
// names any more. Used after a handle (or a folder of them) is deleted.
func (h *PagesHandler) collectIfUnreferenced(ctx context.Context, ns string, ids []string) {
	if len(ids) == 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	still := map[string]bool{}
	for _, ref := range h.handlesIn(ctx, ns, "") {
		still[ref.id] = true
	}
	for _, id := range ids {
		if !still[id] {
			h.removeStored(ns, id)
		}
	}
}

// DeleteHook wraps DELETE /api/note: when the deleted path is a handle, or a
// folder holding handles, the pages they name are deleted too, unless another
// handle in the namespace still names them. It runs inside the route's own
// permission check, and only after the note delete succeeded.
func (h *PagesHandler) DeleteHook(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			next.ServeHTTP(w, r)
			return
		}
		ns := r.URL.Query().Get("ns")
		rel, ok := SafeRelPath(r.URL.Query().Get("path"))
		if !ValidNamespaceName(ns) || !ok {
			next.ServeHTTP(w, r)
			return
		}
		var ids []string
		if info, err := h.store.Stat(r.Context(), ns, rel); err == nil {
			if info.IsDir {
				for _, ref := range h.handlesIn(r.Context(), ns, rel) {
					ids = append(ids, ref.id)
				}
			} else if IsPageHandlePath(rel) && info.Size <= maxHandleSize {
				if data, err := h.store.ReadFile(r.Context(), ns, rel); err == nil {
					if id, ok := ParsePageHandle(string(data)); ok && ValidPageID(id) {
						ids = append(ids, id)
					}
				}
			}
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		if sw.status < 300 && len(ids) > 0 {
			h.collectIfUnreferenced(r.Context(), ns, ids)
		}
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// handlePublish serves PUT /api/pages?ns=&path=<name>.page.md: stores the page
// under a new id and writes the handle (new, or updated to the new id). It
// needs write on that handle only. A .page.md that is not a handle is never
// overwritten (409).
func (h *PagesHandler) handlePublish(w http.ResponseWriter, r *http.Request) {
	ns, rel, ok := h.requireHandlePath(w, r)
	if !ok {
		return
	}
	if !h.canWritePath(r, ns, rel) {
		middleware.DenyJSON(w)
		return
	}
	ctx := r.Context()
	// Every publish stores the content under a NEW id, then points the
	// handles the publisher can write at it (see rotateHandles). A page is
	// never replaced in place: a handle is readable, so its id is no secret
	// from readers, and replacing by id would let anyone who can write one
	// handle change what every other handle naming that id shows.
	oldID := ""
	if data, err := h.store.ReadFile(ctx, ns, rel); err == nil {
		existing, isHandle := ParsePageHandle(string(data))
		if !isHandle {
			pagesError(w, http.StatusConflict, rel+" exists and is not a page handle; choose another name")
			return
		}
		if ValidPageID(existing) {
			oldID = existing
		}
	} else if !errors.Is(err, storage.ErrNotExist) {
		pagesError(w, http.StatusInternalServerError, "failed to read the handle")
		return
	}
	id := newPageID()

	nsDir := h.nsDir(ns)
	if nsDir == "" {
		pagesError(w, http.StatusBadRequest, "invalid namespace")
		return
	}
	if err := os.MkdirAll(filepath.Join(nsDir, pagesMetaDir), 0755); err != nil {
		log.Printf("pages: cannot create %s: %v", nsDir, err)
		pagesError(w, http.StatusInternalServerError, "failed to store page")
		return
	}
	// The body may be a little larger than the files it carries (tar headers
	// and padding); the real limit is counted on the files themselves.
	overhead := int64(h.cfg.MaxFiles)*1024 + (1 << 20)
	r.Body = http.MaxBytesReader(w, r.Body, h.cfg.MaxBytes+overhead)

	tmp := filepath.Join(nsDir, ".tmp-"+randHex(8))
	if err := os.Mkdir(tmp, 0755); err != nil {
		pagesError(w, http.StatusInternalServerError, "failed to store page")
		return
	}
	defer os.RemoveAll(tmp) // gone after a successful rename; cleans up on error

	total, files, err := h.extractPage(r, tmp)
	if err != nil {
		var pe *errPageInput
		var mbe *http.MaxBytesError
		switch {
		case errors.As(err, &pe):
			pagesError(w, pe.status, pe.msg)
		case errors.As(err, &mbe):
			pagesError(w, http.StatusRequestEntityTooLarge, h.tooBigMsg())
		default:
			log.Printf("pages: publish %s/%s: %v", ns, rel, err)
			pagesError(w, http.StatusBadRequest, "could not read the uploaded page")
		}
		return
	}
	indexBytes, err := os.ReadFile(filepath.Join(tmp, "index.html"))
	if err != nil {
		pagesError(w, http.StatusBadRequest, "a page needs an index.html at its top level")
		return
	}
	title, text := ExtractPageText(indexBytes)
	if title == "" {
		title = strings.TrimSuffix(path.Base(rel), PageHandleSuffix)
	}
	meta := PageMeta{
		ID:          id,
		Title:       title,
		Author:      plainField(h.author(r)),
		PublishedAt: time.Now().UTC().Format(time.RFC3339),
		Bytes:       total,
		Files:       files,
		Text:        text,
		Version:     randHex(12),
	}

	h.mu.Lock()
	dest, metaFile := h.pageDir(ns, id), h.metaPath(ns, id)
	if dest == "" || metaFile == "" {
		h.mu.Unlock()
		pagesError(w, http.StatusBadRequest, "invalid page")
		return
	}
	if err := os.Rename(tmp, dest); err != nil {
		h.mu.Unlock()
		pagesError(w, http.StatusInternalServerError, "failed to store page")
		return
	}
	mb, _ := json.Marshal(pageMetaFile{PageMeta: meta, Version: meta.Version})
	tmpMeta := metaFile + ".tmp-" + randHex(4)
	if err := os.WriteFile(tmpMeta, mb, 0644); err != nil || os.Rename(tmpMeta, metaFile) != nil {
		os.Remove(tmpMeta)
		os.RemoveAll(dest)
		h.mu.Unlock()
		pagesError(w, http.StatusInternalServerError, "failed to store page details")
		return
	}
	h.mu.Unlock()
	// The handle last: it is what makes the page visible.
	unlock := lockNote(ns, rel)
	err = h.store.WriteFile(ctx, ns, rel, []byte(pageHandleContent(id, meta)))
	unlock()
	if err != nil {
		log.Printf("pages: write handle %s/%s: %v", ns, rel, err)
		h.mu.Lock()
		h.removeStored(ns, id)
		h.mu.Unlock()
		pagesError(w, http.StatusInternalServerError, "failed to write the page handle")
		return
	}
	if oldID != "" && oldID != id {
		h.rotateHandles(r, ns, rel, oldID, id)
		h.collectIfUnreferenced(ctx, ns, []string{oldID})
	}
	meta.Text = ""
	meta.Path = rel
	pagesJSON(w, http.StatusOK, meta)
}

// rotateHandles points every other handle in the namespace that names oldID,
// and that the publisher can write, at newID. Handles the publisher cannot
// write keep oldID, and with it the old page, which stays stored for as long
// as any handle names it. So a publish never changes what a handle the
// publisher cannot write shows, and an id someone saved only ever opens the
// version they could already read.
func (h *PagesHandler) rotateHandles(r *http.Request, ns, published, oldID, newID string) {
	ctx := r.Context()
	for _, ref := range h.handlesIn(ctx, ns, "") {
		if ref.id != oldID || ref.path == published || !h.canWritePath(r, ns, ref.path) {
			continue
		}
		unlock := lockNote(ns, ref.path)
		data, err := h.store.ReadFile(ctx, ns, ref.path)
		if err == nil {
			if id, ok := ParsePageHandle(string(data)); ok && id == oldID {
				if rewritten, ok := rewriteHandleID(string(data), newID); ok {
					if err := h.store.WriteFile(ctx, ns, ref.path, []byte(rewritten)); err != nil {
						log.Printf("pages: point %s/%s at the new page: %v", ns, ref.path, err)
					}
				}
			}
		}
		unlock()
	}
}

// handleDelete serves DELETE /api/pages?ns=&path=: removes the handle and,
// unless another handle names the same page, the page.
func (h *PagesHandler) handleDelete(w http.ResponseWriter, r *http.Request) {
	ns, rel, ok := h.requireHandlePath(w, r)
	if !ok {
		return
	}
	if !h.canWritePath(r, ns, rel) {
		middleware.DenyJSON(w)
		return
	}
	ctx := r.Context()
	data, err := h.store.ReadFile(ctx, ns, rel)
	if err != nil {
		pagesError(w, http.StatusNotFound, "page not found")
		return
	}
	id, isHandle := ParsePageHandle(string(data))
	if !isHandle {
		pagesError(w, http.StatusBadRequest, "not a page handle (no page: key in its front matter)")
		return
	}
	unlock := lockNote(ns, rel)
	err = h.store.Remove(ctx, ns, rel)
	unlock()
	if err != nil {
		pagesError(w, http.StatusInternalServerError, "failed to delete the handle")
		return
	}
	if ValidPageID(id) {
		h.collectIfUnreferenced(ctx, ns, []string{id})
	}
	pagesJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// HandleText serves GET /api/pages/text?ns=&path=: the page's details and the
// visible text pulled out at publish time (never the raw HTML). With
// format=text, the text alone as text/plain, for the CLI.
func (h *PagesHandler) HandleText(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, rel, ok := h.requireHandlePath(w, r)
	if !ok {
		return
	}
	if !h.canReadPath(r, ns, rel) {
		middleware.DenyJSON(w)
		return
	}
	_, m, ok := h.handleAt(r.Context(), w, ns, rel)
	if !ok {
		return
	}
	if r.URL.Query().Get("format") == "text" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, m.Text)
		return
	}
	pagesJSON(w, http.StatusOK, m)
}

// HandleArchive serves GET /api/pages/archive?ns=&path=: the page's files as
// a tar, for `mdnest page pull`.
func (h *PagesHandler) HandleArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, rel, ok := h.requireHandlePath(w, r)
	if !ok {
		return
	}
	if !h.canReadPath(r, ns, rel) {
		middleware.DenyJSON(w)
		return
	}
	id, _, ok := h.handleAt(r.Context(), w, ns, rel)
	if !ok {
		return
	}
	dir := h.pageDir(ns, id)
	if st, err := os.Stat(dir); dir == "" || err != nil || !st.IsDir() {
		pagesError(w, http.StatusNotFound, errPageFilesMissing)
		return
	}
	name := strings.TrimSuffix(path.Base(rel), PageHandleSuffix)
	w.Header().Set("Content-Type", "application/x-tar")
	w.Header().Set("Content-Disposition", contentDisposition(name+".tar"))
	writePageTar(w, dir)
}

// HandlePass serves POST /api/pages/pass?ns=&path=: a frame URL for the page
// a handle names, after a read check on the handle. The browser asks for a
// new one each time a page is opened.
func (h *PagesHandler) HandlePass(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		pagesError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, rel, ok := h.requireHandlePath(w, r)
	if !ok {
		return
	}
	if !h.canReadPath(r, ns, rel) {
		middleware.DenyJSON(w)
		return
	}
	id, m, ok := h.handleAt(r.Context(), w, ns, rel)
	if !ok {
		return
	}
	pass, exp, err := h.mintPass(ns, id, m.Version)
	if err != nil {
		pagesError(w, http.StatusInternalServerError, "failed to create page pass")
		return
	}
	base := "/api/pages/view"
	if h.ScriptMode() {
		base = strings.TrimRight(h.cfg.Origin, "/")
	}
	pagesJSON(w, http.StatusOK, map[string]any{
		"url":         base + "/" + pass + "/",
		"scripts":     h.ScriptMode(),
		"expiresAt":   exp.UTC().Format(time.RFC3339),
		"title":       m.Title,
		"author":      m.Author,
		"publishedAt": m.PublishedAt,
	})
}

// ---- carrying a page across namespaces (transfer.go) ----

// rewriteHandleID returns the handle with its `page:` line set to id. Only the
// first `page:` key in the front matter is changed; the rest is kept as is.
func rewriteHandleID(content, id string) (string, bool) {
	c := strings.TrimPrefix(content, "\ufeff")
	if !strings.HasPrefix(c, "---\n") && !strings.HasPrefix(c, "---\r\n") {
		return content, false
	}
	lines := strings.SplitAfter(c, "\n")
	for i := 1; i < len(lines); i++ {
		line := strings.TrimRight(lines[i], "\r\n")
		if line == "---" {
			break
		}
		if k, _, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) == "page" && !strings.HasPrefix(line, " ") {
			nl := lines[i][len(strings.TrimRight(lines[i], "\r\n")):]
			lines[i] = "page: " + id + nl
			return strings.Join(lines, ""), true
		}
	}
	return content, false
}

// pageStored reports whether a namespace holds the page id.
func (h *PagesHandler) pageStored(ns, id string) bool {
	p := h.metaPath(ns, id)
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// copyPageFiles copies a page folder's regular files. A package variable so
// a test can make a carry fail and check the rollback.
var copyPageFiles = func(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		if !d.Type().IsRegular() {
			return nil // never stored; never carried
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if err != nil {
			return err
		}
		if _, err := io.Copy(out, in); err != nil {
			out.Close()
			return err
		}
		return out.Close()
	})
}

// CarryPage copies the page id of fromNS into toNS for a handle being
// transferred, and returns the id the destination handle must name: the same
// id, or a new one when toNS already has a page under it. carried is false
// when fromNS does not hold the page (the handle then travels alone, and
// shows the "published in another namespace" 404). The copy is complete or
// absent: it is built in a temp folder and renamed into place.
func (h *PagesHandler) CarryPage(fromNS, id, toNS string) (destID string, carried bool, err error) {
	if !ValidPageID(id) || !h.pageStored(fromNS, id) {
		return id, false, nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	destID = id
	if h.pageStored(toNS, destID) {
		destID = newPageID()
	}
	nsDir := h.nsDir(toNS)
	if nsDir == "" {
		return "", false, fmt.Errorf("invalid namespace %q", toNS)
	}
	if err := os.MkdirAll(filepath.Join(nsDir, pagesMetaDir), 0755); err != nil {
		return "", false, err
	}
	tmp := filepath.Join(nsDir, ".tmp-"+randHex(8))
	defer os.RemoveAll(tmp)
	if err := copyPageFiles(h.pageDir(fromNS, id), tmp); err != nil {
		return "", false, err
	}
	m, err := h.readMeta(fromNS, id)
	if err != nil {
		return "", false, err
	}
	m.ID = destID
	mb, _ := json.Marshal(pageMetaFile{PageMeta: *m, Version: randHex(12)})
	tmpMeta := h.metaPath(toNS, destID) + ".tmp-" + randHex(4)
	if err := os.WriteFile(tmpMeta, mb, 0644); err != nil {
		os.Remove(tmpMeta)
		return "", false, err
	}
	if err := os.Rename(tmp, h.pageDir(toNS, destID)); err != nil {
		os.Remove(tmpMeta)
		return "", false, err
	}
	if err := os.Rename(tmpMeta, h.metaPath(toNS, destID)); err != nil {
		os.Remove(tmpMeta)
		os.RemoveAll(h.pageDir(toNS, destID))
		return "", false, err
	}
	return destID, true, nil
}

// UndoCarry removes a page CarryPage put in toNS (a failed transfer).
func (h *PagesHandler) UndoCarry(toNS, destID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.removeStored(toNS, destID)
}

// AfterMove is called once a move across namespaces is complete: each page
// carried out of fromNS is removed there, unless a handle left in fromNS
// still names it (then the move was, for the page, a copy).
func (h *PagesHandler) AfterMove(ctx context.Context, fromNS string, ids []string) {
	h.collectIfUnreferenced(ctx, fromNS, ids)
}
