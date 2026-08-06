package handlers

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// starterTheme is a neutral example theme seeded into the catalog on first
// start (when theme management is enabled). Admins can edit, rename (create a
// copy), or delete it; the seed never overwrites an existing theme of the same
// name, and it only seeds when the catalog is empty so a deleted starter does
// not reappear once you have your own themes.
//
//go:embed marp_starter.css
var starterTheme string

// maxThemeBytes caps a single theme stylesheet.
const maxThemeBytes = 512 * 1024

// themeNameRe validates a theme's name — it doubles as the CSS filename
// (<name>.css), so it must be a safe, traversal-free slug and also a valid
// Marp `@theme` identifier.
var themeNameRe = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

// MarpThemeHandler serves the centralized Marp theme catalog stored in the
// reserved, hidden namespace storage.SystemNamespaceMarpThemes. Themes are a
// global presentation catalog: any authenticated user may read them (to render
// a deck in any namespace), and only a superadmin may create/update/delete.
type MarpThemeHandler struct {
	store storage.Storage
}

// NewMarpThemeHandler builds the handler over the given storage backend.
func NewMarpThemeHandler(store storage.Storage) *MarpThemeHandler {
	return &MarpThemeHandler{store: store}
}

type marpTheme struct {
	Name string `json:"name"`
	CSS  string `json:"css"`
}

// Handle routes /api/marp/themes. GET is open to any authenticated user; POST
// (upsert) and DELETE require a superadmin. Single-user mode (no user context)
// allows everything.
func (h *MarpThemeHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.list(w, r)
	case http.MethodPost, http.MethodPut:
		if !h.requireSuperAdmin(w, r) {
			return
		}
		h.upsert(w, r)
	case http.MethodDelete:
		if !h.requireSuperAdmin(w, r) {
			return
		}
		h.remove(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// requireSuperAdmin allows single-user mode (no user context) and superadmins.
func (h *MarpThemeHandler) requireSuperAdmin(w http.ResponseWriter, r *http.Request) bool {
	if uc := middleware.UserFromContext(r.Context()); uc != nil && uc.Role != "superadmin" {
		http.Error(w, `{"error":"superadmin access required"}`, http.StatusForbidden)
		return false
	}
	return true
}

func (h *MarpThemeHandler) list(w http.ResponseWriter, r *http.Request) {
	themes, err := h.readAll(r.Context())
	if err != nil {
		log.Printf("marp themes: list failed: %v", err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(themes)
}

func (h *MarpThemeHandler) readAll(ctx context.Context) ([]marpTheme, error) {
	entries, err := h.store.ReadDir(ctx, storage.SystemNamespaceMarpThemes, "")
	if err != nil {
		if errors.Is(err, storage.ErrNotExist) {
			return []marpTheme{}, nil // nothing seeded yet
		}
		return nil, err
	}
	themes := make([]marpTheme, 0, len(entries))
	for _, e := range entries {
		if e.IsDir || !strings.HasSuffix(e.Name, ".css") {
			continue
		}
		data, rerr := h.store.ReadFile(ctx, storage.SystemNamespaceMarpThemes, e.Name)
		if rerr != nil {
			continue
		}
		themes = append(themes, marpTheme{
			Name: strings.TrimSuffix(e.Name, ".css"),
			CSS:  string(data),
		})
	}
	return themes, nil
}

func (h *MarpThemeHandler) upsert(w http.ResponseWriter, r *http.Request) {
	var req marpTheme
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(req.Name)
	if !themeNameRe.MatchString(name) {
		http.Error(w, `{"error":"name must match ^[a-z][a-z0-9-]{0,63}$"}`, http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.CSS) == "" {
		http.Error(w, `{"error":"css is required"}`, http.StatusBadRequest)
		return
	}
	if len(req.CSS) > maxThemeBytes {
		http.Error(w, `{"error":"css too large"}`, http.StatusRequestEntityTooLarge)
		return
	}
	_ = h.store.MkdirAll(r.Context(), storage.SystemNamespaceMarpThemes, "")
	if err := h.store.WriteFile(r.Context(), storage.SystemNamespaceMarpThemes, name+".css", []byte(req.CSS)); err != nil {
		log.Printf("marp themes: write %q failed: %v", name, err)
		http.Error(w, `{"error":"failed to save theme"}`, http.StatusInternalServerError)
		return
	}
	log.Printf("marp theme saved: %q (%d bytes)", name, len(req.CSS))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(marpTheme{Name: name, CSS: req.CSS})
}

func (h *MarpThemeHandler) remove(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if !themeNameRe.MatchString(name) {
		http.Error(w, `{"error":"invalid name"}`, http.StatusBadRequest)
		return
	}
	if err := h.store.Remove(r.Context(), storage.SystemNamespaceMarpThemes, name+".css"); err != nil && !errors.Is(err, storage.ErrNotExist) {
		log.Printf("marp themes: delete %q failed: %v", name, err)
		http.Error(w, `{"error":"failed to delete theme"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// SeedDefault writes the neutral starter theme, but only when the catalog is
// completely empty — so a first-run instance has a working example, while an
// admin who deleted it (and has their own themes) never sees it come back.
// Idempotent and best effort: failures are logged, not fatal.
func (h *MarpThemeHandler) SeedDefault(ctx context.Context) {
	const name = "starter"
	if existing, err := h.readAll(ctx); err == nil && len(existing) > 0 {
		return // catalog already has themes — don't reintroduce the starter
	}
	_ = h.store.MkdirAll(ctx, storage.SystemNamespaceMarpThemes, "")
	if err := h.store.WriteFile(ctx, storage.SystemNamespaceMarpThemes, name+".css", []byte(starterTheme)); err != nil {
		log.Printf("marp themes: seed %q failed: %v", name, err)
		return
	}
	log.Printf("marp themes: seeded starter theme %q", name)
}
