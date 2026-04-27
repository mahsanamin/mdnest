package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// AdminHandler handles user management endpoints (multi mode only).
type AdminHandler struct {
	userStore    store.UserStore
	grantStore   store.GrantStore
	nsAdminStore store.NamespaceAdminStore
	hub          *collab.Hub // nil if collab disabled
}

// NewAdminHandler creates a new admin handler.
func NewAdminHandler(userStore store.UserStore, grantStore store.GrantStore, nsAdminStore store.NamespaceAdminStore, hub *collab.Hub) *AdminHandler {
	return &AdminHandler{
		userStore:    userStore,
		grantStore:   grantStore,
		nsAdminStore: nsAdminStore,
		hub:          hub,
	}
}

// callerCanAdminNamespace returns true if the request's user is allowed to
// take administrative actions on the given namespace — i.e. they're a
// superadmin OR a namespace admin of that ns. Used by every handler that
// scopes actions per-namespace.
func (h *AdminHandler) callerCanAdminNamespace(r *http.Request, namespace string) bool {
	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		return true // single-user mode
	}
	if uc.Role == "superadmin" {
		return true
	}
	if uc.Role == "admin" && namespace != "" {
		ok, _ := h.nsAdminStore.IsAdminOf(uc.ID, namespace)
		return ok
	}
	return false
}

// callerAdminNamespaces returns the set of namespaces the caller can
// administer. Returns nil + true for superadmins (meaning "all"), or the
// list + false for namespace admins.
func (h *AdminHandler) callerAdminNamespaces(r *http.Request) (nsList []string, all bool) {
	uc := middleware.UserFromContext(r.Context())
	if uc == nil || uc.Role == "superadmin" {
		return nil, true
	}
	if uc.Role == "admin" {
		nsList, _ = h.nsAdminStore.ListByUser(uc.ID)
	}
	return nsList, false
}

func (h *AdminHandler) notifyAccessChanged() {
	if h.hub != nil {
		h.hub.BroadcastAccessChanged()
	}
}

type inviteRequest struct {
	Email    string `json:"email"`
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
	// Namespace is required when the caller is a namespace admin (not a
	// superadmin) — the new user is auto-granted write on this ns. Ignored
	// for superadmin callers, who can grant access separately.
	Namespace string `json:"namespace"`
}

type userResponse struct {
	ID        int    `json:"id"`
	Email     string `json:"email"`
	Username  string `json:"username"`
	Role      string `json:"role"`
	InvitedBy *int   `json:"invited_by,omitempty"`
	CreatedAt string `json:"created_at"`
}

type updateRoleRequest struct {
	Role string `json:"role"`
}

func toUserResponse(u *store.User) userResponse {
	return userResponse{
		ID:        u.ID,
		Email:     u.Email,
		Username:  u.Username,
		Role:      u.Role,
		InvitedBy: u.InvitedBy,
		CreatedAt: u.CreatedAt.Format(time.RFC3339),
	}
}

// HandleInvite handles POST /api/admin/invite.
func (h *AdminHandler) HandleInvite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req inviteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if req.Email == "" || req.Username == "" || req.Password == "" {
		http.Error(w, `{"error":"email, username, and password are required"}`, http.StatusBadRequest)
		return
	}

	if req.Role == "" {
		req.Role = "collaborator"
	}
	if req.Role != "superadmin" && req.Role != "admin" && req.Role != "collaborator" {
		http.Error(w, `{"error":"role must be superadmin, admin, or collaborator"}`, http.StatusBadRequest)
		return
	}

	// Authorization: the invite role must be allowed for the caller.
	uc := middleware.UserFromContext(r.Context())
	isSuperAdmin := uc != nil && uc.Role == "superadmin"
	if req.Role == "superadmin" && !isSuperAdmin {
		http.Error(w, `{"error":"only superadmin can invite a superadmin"}`, http.StatusForbidden)
		return
	}
	// Namespace admins must scope the invite to a namespace they admin.
	// Superadmins can invite without a namespace and grant access later.
	if !isSuperAdmin {
		if req.Namespace == "" {
			http.Error(w, `{"error":"namespace is required when inviting as a namespace admin"}`, http.StatusBadRequest)
			return
		}
		if !h.callerCanAdminNamespace(r, req.Namespace) {
			http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
			return
		}
	}

	// Check for duplicate email
	existing, err := h.userStore.GetUserByEmail(req.Email)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if existing != nil {
		http.Error(w, `{"error":"email already in use"}`, http.StatusConflict)
		return
	}

	// Check for duplicate username
	existing, err = h.userStore.GetUserByUsername(req.Username)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if existing != nil {
		http.Error(w, `{"error":"username already in use"}`, http.StatusConflict)
		return
	}

	// Get inviting admin's ID
	var invitedBy *int
	if uc != nil {
		invitedBy = &uc.ID
	}

	user, err := h.userStore.CreateUser(req.Email, req.Username, req.Password, req.Role, invitedBy)
	if err != nil {
		log.Printf("failed to create user: %v", err)
		http.Error(w, `{"error":"failed to create user"}`, http.StatusInternalServerError)
		return
	}

	// If a namespace was specified (always for non-superadmin callers,
	// optional for superadmins), auto-grant write access on it. For
	// role="admin" also add a namespace_admins row so the new user
	// inherits administrative powers on that ns.
	if req.Namespace != "" {
		if _, err := h.grantStore.CreateGrant(user.ID, req.Namespace, "/", "write", invitedBy); err != nil {
			log.Printf("invite: failed to auto-grant write on %s for new user %d: %v", req.Namespace, user.ID, err)
			// Non-fatal — user is created, operator can grant manually.
		}
		if req.Role == "admin" {
			if err := h.nsAdminStore.Add(user.ID, req.Namespace, invitedBy); err != nil {
				log.Printf("invite: failed to add namespace_admins row for new user %d ns=%s: %v", user.ID, req.Namespace, err)
			}
		}
	}

	log.Printf("user invited: %s (%s) role=%s ns=%s", user.Username, user.Email, user.Role, req.Namespace)
	h.notifyAccessChanged()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toUserResponse(user))
}

// HandleUsers dispatches GET/PUT/DELETE /api/admin/users.
// GET is permitted for namespace admins (results are scoped). PUT (role
// change) and DELETE (remove user) are superadmin-only — those touch
// global state.
func (h *AdminHandler) HandleUsers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listUsers(w, r)
	case http.MethodDelete:
		if !middleware.IsSuperAdmin(r.Context()) {
			http.Error(w, `{"error":"superadmin access required"}`, http.StatusForbidden)
			return
		}
		h.deleteUser(w, r)
	case http.MethodPut:
		if !middleware.IsSuperAdmin(r.Context()) {
			http.Error(w, `{"error":"superadmin access required"}`, http.StatusForbidden)
			return
		}
		h.updateUserRole(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *AdminHandler) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.userStore.ListUsers()
	if err != nil {
		log.Printf("failed to list users: %v", err)
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	// Scope: superadmins see all users; namespace admins see only users
	// who have grants OR namespace_admins entries in any namespace they
	// administer (themselves always included). Filter is best-effort —
	// errors building the visibility set fall back to "self only".
	adminNs, isAll := h.callerAdminNamespaces(r)
	if !isAll {
		visible := h.usersVisibleToAdmin(r, adminNs)
		filtered := users[:0]
		for _, u := range users {
			if visible[u.ID] {
				filtered = append(filtered, u)
			}
		}
		users = filtered
	}

	resp := make([]userResponse, 0, len(users))
	for i := range users {
		resp = append(resp, toUserResponse(&users[i]))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

// usersVisibleToAdmin returns the set of user IDs a namespace-scoped admin
// is allowed to see — those with grants or namespace_admins entries on
// any of the admin's namespaces, plus the admin themselves.
func (h *AdminHandler) usersVisibleToAdmin(r *http.Request, adminNs []string) map[int]bool {
	visible := map[int]bool{}
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		visible[uc.ID] = true
	}
	for _, ns := range adminNs {
		grants, err := h.grantStore.GetGrantsForNamespace(ns)
		if err == nil {
			for _, g := range grants {
				visible[g.UserID] = true
			}
		}
		nsAdmins, err := h.nsAdminStore.ListByNamespace(ns)
		if err == nil {
			for _, a := range nsAdmins {
				visible[a.UserID] = true
			}
		}
	}
	return visible
}

func (h *AdminHandler) deleteUser(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	if idStr == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}

	// Prevent deleting yourself
	if uc := middleware.UserFromContext(r.Context()); uc != nil && uc.ID == id {
		http.Error(w, `{"error":"cannot delete yourself"}`, http.StatusBadRequest)
		return
	}

	// Prevent deleting the last superadmin
	if err := h.ensureNotLastSuperAdmin(id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}

	if err := h.userStore.DeleteUser(id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	log.Printf("user deleted: id=%d", id)
	h.notifyAccessChanged()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func (h *AdminHandler) updateUserRole(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	if idStr == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}

	var req updateRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.Role != "superadmin" && req.Role != "admin" && req.Role != "collaborator" {
		http.Error(w, `{"error":"role must be superadmin, admin, or collaborator"}`, http.StatusBadRequest)
		return
	}

	// If demoting away from superadmin, check it's not the last superadmin.
	if req.Role != "superadmin" {
		if err := h.ensureNotLastSuperAdmin(id); err != nil {
			http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
			return
		}
	}

	if err := h.userStore.UpdateRole(id, req.Role); err != nil {
		http.Error(w, `{"error":"failed to update role"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("user role updated: id=%d role=%s", id, req.Role)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// --- Grant management ---

type createGrantRequest struct {
	UserID     int    `json:"user_id"`
	Namespace  string `json:"namespace"`
	Path       string `json:"path"`
	Permission string `json:"permission"`
}

type grantResponse struct {
	ID         int    `json:"id"`
	UserID     int    `json:"user_id"`
	Username   string `json:"username,omitempty"`
	Namespace  string `json:"namespace"`
	Path       string `json:"path"`
	Permission string `json:"permission"`
	GrantedBy  *int   `json:"granted_by,omitempty"`
	CreatedAt  string `json:"created_at"`
}

func toGrantResponse(g *store.Grant) grantResponse {
	return grantResponse{
		ID:         g.ID,
		UserID:     g.UserID,
		Namespace:  g.Namespace,
		Path:       g.Path,
		Permission: g.Permission,
		GrantedBy:  g.GrantedBy,
		CreatedAt:  g.CreatedAt.Format(time.RFC3339),
	}
}

func toGrantWithUserResponse(g *store.GrantWithUser) grantResponse {
	return grantResponse{
		ID:         g.ID,
		UserID:     g.UserID,
		Username:   g.Username,
		Namespace:  g.Namespace,
		Path:       g.Path,
		Permission: g.Permission,
		GrantedBy:  g.GrantedBy,
		CreatedAt:  g.CreatedAt.Format(time.RFC3339),
	}
}

// HandleGrants dispatches POST/GET/PUT/DELETE /api/admin/grants.
func (h *AdminHandler) HandleGrants(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.createGrant(w, r)
	case http.MethodGet:
		h.listGrants(w, r)
	case http.MethodPut:
		h.updateGrant(w, r)
	case http.MethodDelete:
		h.deleteGrant(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *AdminHandler) createGrant(w http.ResponseWriter, r *http.Request) {
	var req createGrantRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.UserID == 0 || req.Namespace == "" {
		http.Error(w, `{"error":"user_id and namespace are required"}`, http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		req.Path = "/"
	}
	if req.Permission == "" {
		req.Permission = "write"
	}
	if req.Permission != "read" && req.Permission != "write" {
		http.Error(w, `{"error":"permission must be read or write"}`, http.StatusBadRequest)
		return
	}

	// Verify user exists
	user, err := h.userStore.GetUserByID(req.UserID)
	if err != nil || user == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}

	// Scope: namespace admins can only create grants on namespaces they
	// administer. Superadmins can create any grant.
	if !h.callerCanAdminNamespace(r, req.Namespace) {
		http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
		return
	}

	var grantedBy *int
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		grantedBy = &uc.ID
	}

	grant, err := h.grantStore.CreateGrant(req.UserID, req.Namespace, req.Path, req.Permission, grantedBy)
	if err != nil {
		log.Printf("failed to create grant: %v", err)
		http.Error(w, `{"error":"failed to create grant (may already exist)"}`, http.StatusConflict)
		return
	}

	log.Printf("grant created: user=%d ns=%s path=%s perm=%s", req.UserID, req.Namespace, req.Path, req.Permission)
	h.notifyAccessChanged()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toGrantResponse(grant))
}

func (h *AdminHandler) updateGrant(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	if idStr == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		Permission string `json:"permission"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.Permission != "read" && req.Permission != "write" {
		http.Error(w, `{"error":"permission must be read or write"}`, http.StatusBadRequest)
		return
	}

	// Scope check: caller must admin the grant's namespace.
	g, err := h.grantStore.GetGrant(id)
	if err != nil || g == nil {
		http.Error(w, `{"error":"grant not found"}`, http.StatusNotFound)
		return
	}
	if !h.callerCanAdminNamespace(r, g.Namespace) {
		http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
		return
	}

	if err := h.grantStore.UpdateGrantPermission(id, req.Permission); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	log.Printf("grant updated: id=%d permission=%s", id, req.Permission)
	h.notifyAccessChanged()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (h *AdminHandler) listGrants(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.URL.Query().Get("user_id")
	ns := r.URL.Query().Get("namespace")
	path := r.URL.Query().Get("path")

	adminNs, isAll := h.callerAdminNamespaces(r)
	allowedNs := map[string]bool{}
	for _, n := range adminNs {
		allowedNs[n] = true
	}
	allowed := func(grantNs string) bool { return isAll || allowedNs[grantNs] }

	// Filter by namespace + path (for share dialog)
	if ns != "" && path != "" {
		if !allowed(ns) {
			http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
			return
		}
		grants, err := h.grantStore.GetGrantsForPath(ns, path)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		resp := make([]grantResponse, 0, len(grants))
		for i := range grants {
			resp = append(resp, toGrantWithUserResponse(&grants[i]))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}

	// If no filter, return all grants — superadmins see everything,
	// namespace admins see grants only in their admin namespaces.
	if userIDStr == "" && ns == "" {
		allGrants, err := h.grantStore.ListAllGrants()
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		resp := make([]grantResponse, 0, len(allGrants))
		for i := range allGrants {
			if !allowed(allGrants[i].Namespace) {
				continue
			}
			resp = append(resp, toGrantWithUserResponse(&allGrants[i]))
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}

	var grants []store.Grant
	var err error

	if userIDStr != "" {
		userID, parseErr := strconv.Atoi(userIDStr)
		if parseErr != nil {
			http.Error(w, `{"error":"invalid user_id"}`, http.StatusBadRequest)
			return
		}
		grants, err = h.grantStore.GetGrantsForUser(userID)
	} else {
		if !allowed(ns) {
			http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
			return
		}
		grants, err = h.grantStore.GetGrantsForNamespace(ns)
	}

	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	resp := make([]grantResponse, 0, len(grants))
	for i := range grants {
		if !allowed(grants[i].Namespace) {
			continue
		}
		resp = append(resp, toGrantResponse(&grants[i]))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (h *AdminHandler) deleteGrant(w http.ResponseWriter, r *http.Request) {
	idStr := r.URL.Query().Get("id")
	if idStr == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}
	id, err := strconv.Atoi(idStr)
	if err != nil {
		http.Error(w, `{"error":"invalid id"}`, http.StatusBadRequest)
		return
	}

	// Scope check: caller must admin the grant's namespace.
	g, err := h.grantStore.GetGrant(id)
	if err != nil || g == nil {
		http.Error(w, `{"error":"grant not found"}`, http.StatusNotFound)
		return
	}
	if !h.callerCanAdminNamespace(r, g.Namespace) {
		http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
		return
	}

	if err := h.grantStore.DeleteGrant(id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	log.Printf("grant deleted: id=%d", id)
	h.notifyAccessChanged()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// ensureNotLastSuperAdmin returns an error if deleting/demoting the user
// would leave no superadmins. Namespace admins are not load-bearing in
// the same way — a namespace can lose all its admins and the system stays
// recoverable (a superadmin can re-promote someone). A system with no
// superadmins at all is a deadlock.
func (h *AdminHandler) ensureNotLastSuperAdmin(userID int) error {
	user, err := h.userStore.GetUserByID(userID)
	if err != nil || user == nil {
		return nil // not found is fine, delete will handle it
	}
	if user.Role != "superadmin" {
		return nil // not a superadmin, no concern
	}

	users, err := h.userStore.ListUsers()
	if err != nil {
		return err
	}
	count := 0
	for _, u := range users {
		if u.Role == "superadmin" {
			count++
		}
	}
	if count <= 1 {
		return fmt.Errorf("cannot remove the last superadmin")
	}
	return nil
}

// --- Namespace admin assignments ---

type nsAdminResponse struct {
	UserID    int    `json:"user_id"`
	Username  string `json:"username"`
	Email     string `json:"email"`
	Namespace string `json:"namespace"`
	GrantedBy *int   `json:"granted_by,omitempty"`
	CreatedAt string `json:"created_at"`
}

type promoteNsAdminRequest struct {
	UserID    int    `json:"user_id"`
	Namespace string `json:"namespace"`
}

// HandleNamespaceAdmins dispatches GET/POST/DELETE /api/admin/namespace-admins.
//
//   - GET ?ns=<n> — list admins of a namespace. Caller must admin the
//     namespace (superadmin always passes).
//   - POST {user_id, namespace} — promote a user to admin of namespace.
//     Caller must already admin the namespace. Auto-promotes target's
//     users.role from collaborator → admin if needed; auto-creates a
//     write grant on / if none exists.
//   - DELETE ?user_id=<id>&ns=<n> — demote. If the demoted user has no
//     other namespace_admins rows AFTER, demote their users.role back to
//     collaborator. The auto-created write grant is left in place.
func (h *AdminHandler) HandleNamespaceAdmins(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listNamespaceAdmins(w, r)
	case http.MethodPost:
		h.addNamespaceAdmin(w, r)
	case http.MethodDelete:
		h.removeNamespaceAdmin(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *AdminHandler) listNamespaceAdmins(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	if ns == "" {
		http.Error(w, `{"error":"ns is required"}`, http.StatusBadRequest)
		return
	}
	if !h.callerCanAdminNamespace(r, ns) {
		http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
		return
	}

	rows, err := h.nsAdminStore.ListByNamespace(ns)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	resp := make([]nsAdminResponse, 0, len(rows))
	for _, a := range rows {
		resp = append(resp, nsAdminResponse{
			UserID:    a.UserID,
			Username:  a.Username,
			Email:     a.Email,
			Namespace: a.Namespace,
			GrantedBy: a.GrantedBy,
			CreatedAt: a.CreatedAt.Format(time.RFC3339),
		})
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func (h *AdminHandler) addNamespaceAdmin(w http.ResponseWriter, r *http.Request) {
	var req promoteNsAdminRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.UserID == 0 || req.Namespace == "" {
		http.Error(w, `{"error":"user_id and namespace are required"}`, http.StatusBadRequest)
		return
	}
	if !h.callerCanAdminNamespace(r, req.Namespace) {
		http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
		return
	}

	target, err := h.userStore.GetUserByID(req.UserID)
	if err != nil || target == nil {
		http.Error(w, `{"error":"user not found"}`, http.StatusNotFound)
		return
	}
	// Don't downgrade a superadmin to admin; their global role already
	// covers the namespace.
	if target.Role == "superadmin" {
		http.Error(w, `{"error":"user is already a superadmin"}`, http.StatusBadRequest)
		return
	}

	var grantedBy *int
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		grantedBy = &uc.ID
	}

	if err := h.nsAdminStore.Add(req.UserID, req.Namespace, grantedBy); err != nil {
		http.Error(w, `{"error":"failed to add namespace admin"}`, http.StatusInternalServerError)
		return
	}

	// Promote users.role to "admin" if currently collaborator. Idempotent
	// on re-runs.
	if target.Role == "collaborator" {
		if err := h.userStore.UpdateRole(req.UserID, "admin"); err != nil {
			log.Printf("namespace-admin: role bump for user %d failed: %v", req.UserID, err)
		}
	}

	// Auto-create a write grant on path '/' so the new admin can actually
	// open the notes they administer. Idempotent — CreateGrant returns
	// "already exists" which we ignore.
	if _, err := h.grantStore.CreateGrant(req.UserID, req.Namespace, "/", "write", grantedBy); err != nil {
		log.Printf("namespace-admin: auto-grant write on %s for user %d skipped: %v", req.Namespace, req.UserID, err)
	}

	log.Printf("namespace-admin added: user=%d ns=%s", req.UserID, req.Namespace)
	h.notifyAccessChanged()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func (h *AdminHandler) removeNamespaceAdmin(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.URL.Query().Get("user_id")
	ns := r.URL.Query().Get("ns")
	if userIDStr == "" || ns == "" {
		http.Error(w, `{"error":"user_id and ns are required"}`, http.StatusBadRequest)
		return
	}
	userID, err := strconv.Atoi(userIDStr)
	if err != nil {
		http.Error(w, `{"error":"invalid user_id"}`, http.StatusBadRequest)
		return
	}
	if !h.callerCanAdminNamespace(r, ns) {
		http.Error(w, `{"error":"you don't admin that namespace"}`, http.StatusForbidden)
		return
	}

	if err := h.nsAdminStore.Remove(userID, ns); err != nil {
		http.Error(w, `{"error":"failed to remove namespace admin"}`, http.StatusInternalServerError)
		return
	}

	// If the user has no other namespace_admins rows, demote them back
	// to collaborator. The auto-created write grant is left in place so
	// removing the admin role doesn't accidentally take away access.
	if n, err := h.nsAdminStore.CountByUser(userID); err == nil && n == 0 {
		target, err := h.userStore.GetUserByID(userID)
		if err == nil && target != nil && target.Role == "admin" {
			if err := h.userStore.UpdateRole(userID, "collaborator"); err != nil {
				log.Printf("namespace-admin: role demote for user %d failed: %v", userID, err)
			}
		}
	}

	log.Printf("namespace-admin removed: user=%d ns=%s", userID, ns)
	h.notifyAccessChanged()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}
