package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"path"
	"sort"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// TransferHandler serves POST /api/transfer: move or copy a file or folder to
// another namespace (or another place in the same one).
//
// The request names two namespaces in its body, so the query-param permission
// middleware cannot guard it; the handler checks both sides itself, through
// canRead / canWrite. Like the task handler's filter they are REQUIRED: a nil
// check denies, so a forgotten wiring serves 403s, never open access.
//
// Order of checks, all before anything is written: 400 (malformed, root,
// reserved, same place, into itself) → 403 (either side) → 404 → 409
// (collision) → 413 (limits) → 400 (symlink / nested reserved dir). ?dryRun=1
// stops there and answers exactly what the real call would.
//
// A cross-namespace move never renames across namespaces (they may be separate
// mounts, and each commits to its own git repo): it copies, verifies the
// target, and only then deletes the source. A failure before the delete
// removes the partial target and leaves the source untouched.
type TransferHandler struct {
	store    storage.Storage
	limits   TreeLimits
	canRead  func(r *http.Request, ns, path string) bool
	canWrite func(r *http.Request, ns, path string) bool
	// onChange is told every namespace a completed transfer changed, so the
	// search cache and live tree refresh for both sides. May be nil.
	onChange func(ns string)
	// writerProxy, when set (MDNEST_ROLE=app), forwards the request to the
	// writer, which owns the durable tree (an app replica's working set holds
	// neither attachments nor bodies over the cache cap).
	writerProxy http.Handler
	// slots bounds concurrent real transfers like zip downloads: one per user
	// and DOWNLOAD_MAX_CONCURRENT in all. A dry run takes none, so the
	// picker's checks can never starve a transfer.
	slots *downloadSlots
	// chatMembers carries private chats' member lists along (issue #127).
	// Nil unless private chats are on.
	chatMembers chatMembersFollow
	// canWriteDest, when set, replaces canWrite for the destination: the
	// stricter check that also counts member lists left at old chat paths
	// (see PermissionChecker.CheckWriteDest).
	canWriteDest func(r *http.Request, ns, path string) bool
}

// SetChatMembers makes a transfer carry private chats' member lists along,
// checking the destination with canWriteDest.
func (h *TransferHandler) SetChatMembers(m chatMembersFollow, canWriteDest func(r *http.Request, ns, path string) bool) {
	h.chatMembers = m
	h.canWriteDest = canWriteDest
}

// NewTransferHandler builds the handler. canRead and canWrite take a
// namespace and an absolute path ("/a/b.md") like PermissionChecker.CheckRead.
func NewTransferHandler(store storage.Storage, limits TreeLimits, canRead, canWrite func(r *http.Request, ns, path string) bool, onChange func(ns string)) *TransferHandler {
	return &TransferHandler{store: store, limits: limits, canRead: canRead, canWrite: canWrite, onChange: onChange, slots: newDownloadSlots(2)}
}

// SetConcurrency sets the server-wide cap on concurrent transfers
// (DOWNLOAD_MAX_CONCURRENT).
func (h *TransferHandler) SetConcurrency(n int) { h.slots = newDownloadSlots(n) }

// SetWriterProxy makes transfers reverse-proxy to the writer (MDNEST_ROLE=app).
func (h *TransferHandler) SetWriterProxy(p http.Handler) { h.writerProxy = p }

type transferSide struct {
	NS   string `json:"ns"`
	Path string `json:"path"`
}

type transferRequest struct {
	Mode string       `json:"mode"`
	From transferSide `json:"from"`
	To   transferSide `json:"to"`
}

// maxTransferBody bounds the JSON request (two names and two paths).
const maxTransferBody = 64 << 10

// transferError is a refusal with its HTTP status and JSON body.
type transferError struct {
	status int
	body   map[string]any
}

func refuse(status int, msg string) *transferError {
	return &transferError{status: status, body: map[string]any{"error": msg}}
}

func (h *TransferHandler) HandleTransfer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if h.writerProxy != nil {
		h.writerProxy.ServeHTTP(w, r)
		return
	}
	var req transferRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxTransferBody)).Decode(&req); err != nil {
		writeStatusJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	dryRun := r.URL.Query().Get("dryRun") == "1"
	if !dryRun {
		release, err := h.slots.acquire(slotKey(r))
		if err != nil {
			w.Header().Set("Retry-After", zipRetryAfter)
			writeStatusJSON(w, http.StatusTooManyRequests, map[string]string{"error": "busy"})
			return
		}
		defer release()
	}

	ctx := r.Context()
	t, terr := h.prepare(ctx, r, req)
	if terr != nil {
		writeStatusJSON(w, terr.status, terr.body)
		return
	}

	ok := map[string]any{
		"status": "ok",
		"mode":   t.mode,
		"to":     map[string]string{"ns": t.toNS, "path": t.to},
		"items":  t.plan.files,
		// bytes and folder let the picker say how much a confirm will move
		// ("37 files, 12 MB") before the user commits to it.
		"bytes":  t.plan.bytes,
		"folder": t.isDir,
	}

	// The collision check is repeated under a lock on the destination, so two
	// concurrent transfers to one path cannot both pass it and interleave.
	unlock := lockNote("transfer:"+t.toNS, t.to)
	defer unlock()
	if terr := h.checkDestination(ctx, t); terr != nil {
		writeStatusJSON(w, terr.status, terr.body)
		return
	}
	if dryRun {
		writeStatusJSON(w, http.StatusOK, ok)
		return
	}

	// A copy of a private chat is private to the same people, and a moved
	// one stays private: the member lists go first (see chat_members_follow.go).
	copied, carried := chatMembersBeforeMove(h.chatMembers, t.fromNS, t.from, t.toNS, t.to)
	if !carried {
		writeStatusJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to carry chat members"})
		return
	}
	if t.fromNS == t.toNS && t.mode == "move" {
		// Same namespace: a plain rename, exactly what /api/move does.
		err := h.store.Rename(ctx, t.fromNS, t.from, t.to)
		chatMembersAfter(h.chatMembers, copied, err == nil)
		if err != nil {
			writeStatusJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to move item"})
			return
		}
	} else {
		terr := h.execute(ctx, t)
		chatMembersAfter(h.chatMembers, copied, terr == nil)
		if terr != nil {
			writeStatusJSON(w, terr.status, terr.body)
			return
		}
	}

	if h.onChange != nil {
		h.onChange(t.fromNS)
		if t.toNS != t.fromNS {
			h.onChange(t.toNS)
		}
	}
	writeStatusJSON(w, http.StatusOK, ok)
}

// transfer is a validated, authorised request plus what it will carry.
type transfer struct {
	mode         string
	fromNS, from string
	toNS, to     string
	isDir        bool
	plan         *treePlan
}

// cleanSide validates one side of the request. The path is cleaned with the
// same rule the permission check and the storage call use (relpath.Clean),
// so the path that is authorised is the path that is acted on.
func cleanSide(s transferSide, which string) (string, *transferError) {
	if !ValidNamespaceName(s.NS) {
		return "", refuse(http.StatusBadRequest, "invalid "+which+" namespace")
	}
	if p := strings.Trim(strings.TrimSpace(s.Path), "/."); p == "" {
		if which == "source" {
			return "", refuse(http.StatusBadRequest, "the namespace root cannot be moved or copied; choose a file or folder")
		}
		return "", refuse(http.StatusBadRequest, "the destination must name the file or folder to create, not the namespace root")
	}
	rel, ok := SafeRelPath(s.Path)
	if !ok {
		return "", refuse(http.StatusBadRequest, "invalid "+which+" path")
	}
	return rel, nil
}

func (h *TransferHandler) prepare(ctx context.Context, r *http.Request, req transferRequest) (*transfer, *transferError) {
	if req.Mode != "move" && req.Mode != "copy" {
		return nil, refuse(http.StatusBadRequest, `mode must be "move" or "copy"`)
	}
	from, terr := cleanSide(req.From, "source")
	if terr != nil {
		return nil, terr
	}
	to, terr := cleanSide(req.To, "destination")
	if terr != nil {
		return nil, terr
	}
	t := &transfer{mode: req.Mode, fromNS: req.From.NS, from: from, toNS: req.To.NS, to: to}
	if t.fromNS == t.toNS {
		if t.from == t.to {
			return nil, refuse(http.StatusBadRequest, "the destination is the same as the source")
		}
		if strings.HasPrefix(t.to, t.from+"/") {
			return nil, refuse(http.StatusBadRequest, "a folder cannot be moved or copied into itself")
		}
	}

	// Both sides, before touching storage — a caller without access learns
	// nothing about what exists. Grants cover a path and everything below it,
	// so checking the roots covers every file carried.
	srcOK := false
	if t.mode == "copy" {
		srcOK = h.canRead != nil && h.canRead(r, t.fromNS, "/"+t.from)
	} else {
		// The right /api/move requires on its source today: write.
		srcOK = h.canWrite != nil && h.canWrite(r, t.fromNS, "/"+t.from)
	}
	canWriteDest := h.canWrite
	if h.canWriteDest != nil {
		canWriteDest = h.canWriteDest
	}
	if !srcOK || canWriteDest == nil || !canWriteDest(r, t.toNS, "/"+t.to) {
		return nil, refuse(http.StatusForbidden, "access denied")
	}

	for _, ns := range []string{t.fromNS, t.toNS} {
		if ok, err := h.store.NamespaceExists(ctx, ns); err != nil || !ok {
			return nil, refuse(http.StatusNotFound, "namespace not found")
		}
	}
	info, err := h.store.Stat(ctx, t.fromNS, t.from)
	if err != nil {
		return nil, refuse(http.StatusNotFound, "source not found")
	}
	t.isDir = info.IsDir
	if !t.isDir {
		t.plan = &treePlan{entries: []treeEntry{{rel: t.from, size: info.Size, mod: info.ModTime}}, files: 1, bytes: info.Size}
	} else {
		plan, err := planTree(ctx, h.store, t.fromNS, t.from, h.limits)
		if err != nil {
			return nil, refuse(http.StatusInternalServerError, "failed to read source")
		}
		t.plan = plan
	}

	if terr := h.checkDestination(ctx, t); terr != nil {
		return nil, terr
	}
	if t.plan.tooLarge(h.limits) {
		return nil, &transferError{status: http.StatusRequestEntityTooLarge, body: tooLargeBody(t.plan, h.limits)}
	}
	// A move deletes the source tree afterwards, so anything the copy would
	// leave behind (a symlink, a nested .git or .mdnest) would be destroyed.
	// Refuse instead of carrying it or losing it.
	if len(t.plan.symlinks) > 0 {
		return nil, &transferError{status: http.StatusBadRequest, body: map[string]any{"error": "symlink", "path": t.plan.symlinks[0]}}
	}
	if len(t.plan.reserved) > 0 {
		return nil, &transferError{status: http.StatusBadRequest, body: map[string]any{"error": "reserved", "path": t.plan.reserved[0]}}
	}
	return t, nil
}

// checkDestination refuses a destination that exists, or whose parent is a
// file. The destination root must be new, so nothing below it can collide:
// a transfer never merges into or overwrites anything.
func (h *TransferHandler) checkDestination(ctx context.Context, t *transfer) *transferError {
	if _, err := h.store.Stat(ctx, t.toNS, t.to); err == nil {
		return &transferError{status: http.StatusConflict, body: map[string]any{"error": "exists", "path": t.to}}
	}
	for dir := path.Dir(t.to); dir != "." && dir != "/"; dir = path.Dir(dir) {
		if info, err := h.store.Stat(ctx, t.toNS, dir); err == nil {
			if !info.IsDir {
				return &transferError{status: http.StatusConflict, body: map[string]any{"error": "exists", "path": dir}}
			}
			break // an existing directory: its ancestors exist too
		}
	}
	return nil
}

// commentsPath is a note's comment sidecar (see CommentsHandler.commentsFile).
func commentsPath(noteID string) string {
	return path.Join(".mdnest", "comments", noteID+".jsonl")
}

func isMarkdown(rel string) bool {
	return strings.HasSuffix(strings.ToLower(rel), ".md")
}

// execute performs a cross-namespace move or a copy: copy every entry, verify
// the target, and for a move delete the source last.
func (h *TransferHandler) execute(ctx context.Context, t *transfer) *transferError {
	// Detached from the request: once writing starts, a client hanging up
	// must not leave a half-copied tree behind or skip the rollback.
	wctx := context.WithoutCancel(ctx)
	var created []treeEntry    // destination entries this transfer created, in order
	var sidecars []string      // destination comment files this transfer created
	var movedSidecars []string // source comment files to remove after a move
	var threads []movedNote    // moved notes that carry an ID

	// Rollback removes exactly what this transfer created — never the whole
	// destination path, which a concurrent upload or note create may have
	// written into meanwhile. Folders go last, deepest first, and only when
	// they are empty.
	rollback := func() {
		for i := len(sidecars) - 1; i >= 0; i-- {
			_ = h.store.Remove(wctx, t.toNS, sidecars[i])
		}
		h.removeEntries(wctx, t.toNS, created)
	}
	fail := func(err error) *transferError {
		log.Printf("transfer %s %s:%s -> %s:%s failed: %v", t.mode, t.fromNS, t.from, t.toNS, t.to, err)
		rollback()
		return refuse(http.StatusInternalServerError, "transfer failed; nothing was changed")
	}

	dest := func(rel string) string { return t.to + strings.TrimPrefix(rel, t.from) }

	for _, e := range t.plan.entries {
		dst := dest(e.rel)
		switch {
		case e.isDir:
			if err := h.store.MkdirAll(wctx, t.toNS, dst); err != nil {
				return fail(err)
			}
		case isMarkdown(e.rel):
			data, err := h.store.ReadFile(wctx, t.fromNS, e.rel)
			if err != nil {
				return fail(err)
			}
			id, clean := StripAllNoteIDs(string(data))
			if t.mode == "copy" && id != "" {
				// A copy is a new note: new identity, no comments.
				newID, err := GenerateNoteID()
				if err != nil {
					return fail(err)
				}
				data = []byte(InjectNoteID(clean, newID))
			}
			created = append(created, treeEntry{rel: dst})
			if err := h.store.WriteFile(wctx, t.toNS, dst, data); err != nil {
				return fail(err)
			}
			if t.mode == "move" && id != "" {
				threads = append(threads, movedNote{id: id, dst: dst})
			}
		default:
			rc, err := h.store.Open(wctx, t.fromNS, e.rel)
			if err != nil {
				return fail(err)
			}
			created = append(created, treeEntry{rel: dst})
			err = h.store.WriteFrom(wctx, t.toNS, dst, rc, e.size)
			rc.Close()
			if err != nil {
				return fail(err)
			}
		}
		if e.isDir {
			created = append(created, treeEntry{rel: dst, isDir: true})
		}
	}

	// Comment threads follow their note, with two exceptions where the thread
	// is neither copied nor removed — it stays in the source untouched:
	//   - the ID is still claimed by a note left behind, or the namespace is
	//     too big to tell: two notes sharing an ID (an old paste, or a marker
	//     planted by hand or by git) must not let a move take — or copy out —
	//     the other note's thread;
	//   - the destination already has a thread under that ID: a move never
	//     merges into, or writes lines into, a thread that already exists.
	if len(threads) > 0 {
		claimed, complete, err := h.idsClaimedOutside(wctx, t)
		if err != nil {
			return fail(err)
		}
		carried := map[string]bool{}
		for _, n := range threads {
			if carried[n.id] || claimed[n.id] || !complete {
				continue
			}
			carried[n.id] = true
			target, err := h.carryComments(wctx, t, n.id, n.dst)
			if target != "" {
				sidecars = append(sidecars, target) // recorded before the error check: a partial write is rolled back too
			}
			if err != nil {
				return fail(err)
			}
			if target != "" {
				movedSidecars = append(movedSidecars, commentsPath(n.id))
			}
		}
	}

	// Verify before anything is deleted: every entry exists in the target,
	// and every non-note file has the size it had at the source. (A note's
	// bytes may legitimately differ: a copy carries a new marker, and the git
	// backend may reconcile a moved note's marker.)
	for _, e := range t.plan.entries {
		info, err := h.store.Stat(wctx, t.toNS, dest(e.rel))
		if err != nil || info.IsDir != e.isDir {
			return fail(fmt.Errorf("verify %s: missing in target", dest(e.rel)))
		}
		if !e.isDir && !isMarkdown(e.rel) && info.Size != e.size {
			return fail(fmt.Errorf("verify %s: size %d, want %d", dest(e.rel), info.Size, e.size))
		}
	}

	if a, ok := h.store.(storage.Annotator); ok {
		if t.mode == "move" {
			a.Annotate(t.fromNS, fmt.Sprintf("moved to %s:%s", t.toNS, t.to))
			a.Annotate(t.toNS, fmt.Sprintf("moved from %s:%s", t.fromNS, t.from))
		} else {
			a.Annotate(t.toNS, fmt.Sprintf("copied from %s:%s", t.fromNS, t.from))
		}
	}
	if t.mode == "copy" {
		return nil
	}

	// The target is complete and verified; only now does the source go — and
	// only what was planned and copied. A file that arrived in the source
	// folder after planning was not copied, so it is kept (and with it the
	// folder that holds it).
	if !h.removeEntries(wctx, t.fromNS, t.plan.entries) {
		log.Printf("transfer: copied %s:%s to %s:%s but could not remove all of the source", t.fromNS, t.from, t.toNS, t.to)
		return refuse(http.StatusInternalServerError, "copied to the destination, but the source could not be removed")
	}
	for _, sc := range movedSidecars {
		_ = h.store.Remove(wctx, t.fromNS, sc)
	}
	return nil
}

// removeEntries deletes the given files, then the given folders deepest first
// when they are empty. It reports false when a file could not be removed;
// a folder left non-empty by something written meanwhile is not an error.
func (h *TransferHandler) removeEntries(ctx context.Context, ns string, entries []treeEntry) bool {
	ok := true
	var dirs []string
	for _, e := range entries {
		if e.isDir {
			dirs = append(dirs, e.rel)
			continue
		}
		if err := h.store.Remove(ctx, ns, e.rel); err != nil && !errors.Is(err, storage.ErrNotExist) {
			ok = false
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, d := range dirs {
		if list, err := h.store.ReadDir(ctx, ns, d); err == nil && len(list) == 0 {
			_ = h.store.Remove(ctx, ns, d)
		}
	}
	return ok
}

// movedNote is a moved note's ID and its destination path.
type movedNote struct{ id, dst string }

// maxClaimScan bounds how many notes a move reads to learn which IDs are still
// claimed outside the moved set. Past it the answer is "unknown", and no
// thread is carried: each stays, intact, in the source namespace. That costs
// the moved notes their comments in the target, never anyone else's thread.
const maxClaimScan = 5000

// idsClaimedOutside returns every note ID carried by a note in the source
// namespace that is not part of this move, and whether the scan was complete.
func (h *TransferHandler) idsClaimedOutside(ctx context.Context, t *transfer) (map[string]bool, bool, error) {
	claimed := map[string]bool{}
	read := 0
	errTooMany := errors.New("too many notes")
	err := h.store.Walk(ctx, t.fromNS, "", func(rel string, info storage.FileInfo) error {
		if rel == "" || rel == "." {
			return nil
		}
		if relUnder(rel, t.from) {
			if info.IsDir {
				return storage.SkipDir
			}
			return nil
		}
		if info.IsDir {
			if reservedDirName(info.Name) {
				return storage.SkipDir
			}
			return nil
		}
		if info.IsSymlink || !isMarkdown(rel) {
			return nil
		}
		if read++; read > maxClaimScan {
			return errTooMany
		}
		data, err := h.store.ReadFile(ctx, t.fromNS, rel)
		if err != nil {
			return nil // vanished since the walk listed it
		}
		for _, m := range noteIDRegex.FindAllStringSubmatch(string(data), -1) {
			claimed[m[1]] = true
		}
		return nil
	})
	if errors.Is(err, errTooMany) {
		return claimed, false, nil
	}
	return claimed, true, err
}

// carryComments writes a moved note's comment thread to the target, under
// the ID the note actually carries there (the git backend can restore an
// older marker on a path that had a note before; comments filed under the
// moved ID would then be orphaned). It returns the target comment file it
// created, or "" when it carried nothing: no thread, or the target already
// has a thread under that ID — that one belongs to someone else and is never
// merged into. Only lines that decode as a comment are carried, so a comment
// file planted by hand cannot inject arbitrary content.
func (h *TransferHandler) carryComments(ctx context.Context, t *transfer, id, dst string) (string, error) {
	data, err := h.store.ReadFile(ctx, t.fromNS, commentsPath(id))
	if errors.Is(err, storage.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	landed := id
	if b, err := h.store.ReadFile(ctx, t.toNS, dst); err == nil {
		if got, _ := ExtractNoteID(string(b)); got != "" {
			landed = got
		}
	}
	target := commentsPath(landed)
	if _, err := h.store.Stat(ctx, t.toNS, target); err == nil {
		return "", nil
	}
	clean := validCommentLines(data)
	if len(clean) == 0 {
		return "", nil
	}
	return target, h.store.WriteFile(ctx, t.toNS, target, clean)
}

// validCommentLines keeps only the JSONL lines that decode as a Comment with
// an ID.
func validCommentLines(data []byte) []byte {
	var out []byte
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var c Comment
		if json.Unmarshal(line, &c) != nil || c.ID == "" {
			continue
		}
		out = append(out, line...)
		out = append(out, '\n')
	}
	return out
}

// transferPermissionFuncs adapts a PermissionChecker (nil in single mode,
// where the one owner may do anything) into the handler's required checks.
func TransferPermissionFuncs(pc *middleware.PermissionChecker) (canRead, canWrite func(r *http.Request, ns, path string) bool) {
	if pc == nil {
		allow := func(*http.Request, string, string) bool { return true }
		return allow, allow
	}
	// The tree-aware checks: a folder holding a private chat the caller is
	// not on can be neither copied out nor moved (issue #127).
	return pc.CheckReadTree, pc.CheckWriteTree
}
