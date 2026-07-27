package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// MeHandler returns the current user's info and grants.
type MeHandler struct {
	userStore    store.UserStore
	grantStore   store.GrantStore
	nsAdminStore store.NamespaceAdminStore
	store        storage.Storage
}

// NewMeHandler creates a new MeHandler.
func NewMeHandler(userStore store.UserStore, grantStore store.GrantStore, nsAdminStore store.NamespaceAdminStore, store storage.Storage) *MeHandler {
	return &MeHandler{userStore: userStore, grantStore: grantStore, nsAdminStore: nsAdminStore, store: store}
}

type meResponse struct {
	ID        int    `json:"id"`
	Email     string `json:"email"`
	Username  string `json:"username"`
	AvatarURL string `json:"avatar_url,omitempty"`
	Role      string `json:"role"`
	CreatedAt string `json:"created_at"`
	Grants    []meGrant `json:"grants"`
	// IsSuperAdmin is true only for the global "superadmin" role. The
	// frontend uses this to show / hide the system-wide admin actions
	// (reset 2FA, delete user, promote between roles, sync all).
	IsSuperAdmin bool `json:"is_super_admin"`
	// AdminNamespaces is the list of namespaces this user is a
	// namespace-scoped admin of (empty for collaborators and
	// superadmins). The frontend uses it to show only the relevant
	// scope in the admin panel and to show an "(admin)" badge in the
	// sidebar.
	AdminNamespaces []string `json:"admin_namespaces"`
}

type meGrant struct {
	ID         int    `json:"id"`
	Namespace  string `json:"namespace"`
	Path       string `json:"path"`
	Permission string `json:"permission"`
}

// HandleMe handles GET /api/me.
func (h *MeHandler) HandleMe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"user context not found"}`, http.StatusInternalServerError)
		return
	}

	user, err := h.userStore.GetUserByID(uc.ID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusInternalServerError)
		return
	}

	grants, err := h.grantStore.GetGrantsForUser(uc.ID)
	if err != nil {
		grants = nil
	}

	// Auto-provision a per-user personal namespace on the S3 backend. This
	// is the single choke point common to every login mode (SSO, password,
	// Firebase), so it also back-fills existing users on their next load.
	if h.store != nil && h.store.Kind() == "s3" {
		if h.ensurePersonalNamespace(r.Context(), user, grants) {
			if refreshed, rerr := h.grantStore.GetGrantsForUser(uc.ID); rerr == nil {
				grants = refreshed
			}
		}
	}

	meGrants := make([]meGrant, 0, len(grants))
	for _, g := range grants {
		meGrants = append(meGrants, meGrant{
			ID:         g.ID,
			Namespace:  g.Namespace,
			Path:       g.Path,
			Permission: g.Permission,
		})
	}

	avatar := ""
	if user.AvatarURL != nil {
		avatar = *user.AvatarURL
	}

	var adminNs []string
	if h.nsAdminStore != nil {
		adminNs, _ = h.nsAdminStore.ListByUser(user.ID)
	}
	if adminNs == nil {
		adminNs = []string{}
	}

	resp := meResponse{
		ID:              user.ID,
		Email:           user.Email,
		Username:        user.Username,
		AvatarURL:       avatar,
		Role:            user.Role,
		CreatedAt:       user.CreatedAt.Format(time.RFC3339),
		Grants:          meGrants,
		IsSuperAdmin:    user.Role == "superadmin",
		AdminNamespaces: adminNs,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// ensurePersonalNamespace lazily creates a per-user personal namespace on the
// S3 backend and grants the user write access to it. The namespace is named
// after the user's email, which is unique in the users table, so two users can
// never collide on the same storage prefix. It returns true when a new grant
// was created, so the caller can refresh the grant list.
//
// A namespace is only visible to a collaborator through a grant
// (PermissionChecker.FilterNamespaces), so both the storage prefix and the
// write grant are required. Both steps are idempotent: we skip entirely once a
// matching grant already exists, and CreateNamespace tolerates a pre-existing
// prefix, which makes provisioning self-healing across logins.
func (h *MeHandler) ensurePersonalNamespace(ctx context.Context, user *store.User, grants []store.Grant) bool {
	ns := user.Email
	if !ValidNamespaceName(ns) {
		return false
	}
	for _, g := range grants {
		if g.Namespace == ns {
			return false // already provisioned
		}
	}
	if err := h.store.CreateNamespace(ctx, ns); err != nil && !errors.Is(err, storage.ErrExist) {
		log.Printf("personal namespace: create %q for user %d failed: %v", ns, user.ID, err)
		return false
	}
	if _, err := h.grantStore.CreateGrant(user.ID, ns, "/", "write", nil); err != nil {
		log.Printf("personal namespace: grant %q to user %d failed: %v", ns, user.ID, err)
		return false
	}
	log.Printf("personal namespace: provisioned %q for user %d", ns, user.ID)
	return true
}
