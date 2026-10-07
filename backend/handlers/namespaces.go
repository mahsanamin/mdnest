package handlers

import (
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// personalNamespaceLister reports the namespaces that are someone's personal
// workspace, so the management plane can exclude them.
type personalNamespaceLister interface {
	PersonalNamespaces() ([]string, error)
}

// NamespaceHandler lists namespaces via the storage backend.
type NamespaceHandler struct {
	store storage.Storage
	perms *middleware.PermissionChecker // nil in single mode
	// personal lists personal-workspace namespaces to exclude from the
	// management plane; nil in single mode.
	personal personalNamespaceLister
	// notesDir is NOTES_DIR, used only to explain an empty list (files placed
	// directly in it are not in any namespace). Empty: not checked.
	notesDir string
}

// SetNotesDir lets an empty listing say when notes sit directly in NOTES_DIR.
func (h *NamespaceHandler) SetNotesDir(dir string) { h.notesDir = dir }

// Why a namespace list came back empty, sent as X-Namespaces-Empty-Reason so
// the UI can say what to fix. The old message ("Check your mdnest.conf
// mounts") was the same for every cause and named a file a plain Docker
// Compose install does not have (GitHub issue #123).
const (
	// Nothing mounted: NOTES_DIR has no folders. Usually the volumes are on
	// the frontend service instead of the backend, or not mounted at all.
	emptyNoneMounted = "none-mounted"
	// NOTES_DIR holds files but no folders: the notes folder was mounted at
	// /data/notes itself instead of one level down (/data/notes/<name>).
	emptyFilesAtRoot = "files-at-root"
	// Namespaces exist but this account has access to none of them (multi
	// mode: no grant yet; a superadmin has no implicit data access).
	emptyNoAccess = "no-access"
	// NOTES_DIR exists but cannot be read (permissions, SELinux without :z).
	emptyUnreadable = "unreadable"
)

// emptyReason explains an empty result; mounted is how many namespaces exist
// before access filtering.
func (h *NamespaceHandler) emptyReason(mounted int) string {
	if mounted > 0 {
		return emptyNoAccess
	}
	if h.notesDir != "" {
		if entries, err := os.ReadDir(h.notesDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() && e.Type().IsRegular() && len(e.Name()) > 0 && e.Name()[0] != '.' {
					return emptyFilesAtRoot
				}
			}
		}
	}
	return emptyNoneMounted
}

// NewNamespaceHandler creates a new namespace handler.
func NewNamespaceHandler(store storage.Storage, perms *middleware.PermissionChecker, personal personalNamespaceLister) *NamespaceHandler {
	return &NamespaceHandler{store: store, perms: perms, personal: personal}
}

// ListNamespaces handles GET /api/namespaces.
func (h *NamespaceHandler) ListNamespaces(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	names, err := h.store.ListNamespaces(r.Context())
	if err != nil {
		// Unreadable NOTES_DIR: say so instead of a bare 500 the UI can only
		// show as "no namespaces".
		if errors.Is(err, fs.ErrPermission) || os.IsPermission(err) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Namespaces-Empty-Reason", emptyUnreadable)
			w.Write([]byte("[]\n"))
			return
		}
		http.Error(w, `{"error":"failed to read namespaces"}`, http.StatusInternalServerError)
		return
	}
	mounted := len(names)

	// In multi mode, filter to namespaces the user has access to. The
	// management plane (?scope=manage) instead lists the namespaces the
	// caller may administer — a superadmin manages every namespace but no
	// longer has implicit data access, so the admin UI needs this wider list.
	if h.perms != nil {
		if r.URL.Query().Get("scope") == "manage" {
			names = h.perms.FilterManageableNamespaces(r, names)
			// Personal namespaces are self-managed by their owner (implicit
			// access) and are never administered by others, so they must not
			// appear in the admin grant / namespace-admin pickers.
			names = h.excludePersonal(names)
		} else {
			names = h.perms.FilterNamespaces(r, names)
		}
		if names == nil {
			names = []string{}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	if len(names) == 0 {
		w.Header().Set("X-Namespaces-Empty-Reason", h.emptyReason(mounted))
	}
	if r.URL.Query().Get("detail") == "1" {
		json.NewEncoder(w).Encode(h.detail(r, names))
		return
	}
	json.NewEncoder(w).Encode(names)
}

// NamespaceDetail is one row of GET /api/namespaces?detail=1.
type NamespaceDetail struct {
	Name     string `json:"name"`
	CanRead  bool   `json:"canRead"`
	CanWrite bool   `json:"canWrite"`
}

// detail reports read/write access at each namespace's root, computed with the
// same CheckRead/CheckWrite the routes use. It is what the move/copy picker
// offers as destinations; a path-scoped grant below the root shows false here,
// and the transfer dry run has the final word for a specific folder.
func (h *NamespaceHandler) detail(r *http.Request, names []string) []NamespaceDetail {
	out := make([]NamespaceDetail, 0, len(names))
	for _, n := range names {
		d := NamespaceDetail{Name: n, CanRead: true, CanWrite: true}
		if h.perms != nil {
			d.CanRead = h.perms.CheckRead(r, n, "/")
			d.CanWrite = h.perms.CheckWrite(r, n, "/")
		}
		out = append(out, d)
	}
	return out
}

// excludePersonal drops personal-workspace namespaces (the owner's own
// namespace, self-managed via Settings → Git remote) from a management-plane
// list — they are never administered by others.
func (h *NamespaceHandler) excludePersonal(names []string) []string {
	if h.personal == nil {
		return names
	}
	ps, err := h.personal.PersonalNamespaces()
	if err != nil {
		return names
	}
	personal := make(map[string]bool, len(ps))
	for _, p := range ps {
		personal[p] = true
	}
	out := make([]string, 0, len(names))
	for _, n := range names {
		if personal[n] {
			continue
		}
		out = append(out, n)
	}
	return out
}
