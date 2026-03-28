package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// AdminHandler handles user management endpoints (multi mode only).
type AdminHandler struct {
	userStore  store.UserStore
	grantStore store.GrantStore
}

// NewAdminHandler creates a new admin handler.
func NewAdminHandler(userStore store.UserStore, grantStore store.GrantStore) *AdminHandler {
	return &AdminHandler{userStore: userStore, grantStore: grantStore}
}

type inviteRequest struct {
	Email    string `json:"email"`
	Username string `json:"username"`
	Password string `json:"password"`
	Role     string `json:"role"`
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
	if req.Role != "admin" && req.Role != "collaborator" {
		http.Error(w, `{"error":"role must be admin or collaborator"}`, http.StatusBadRequest)
		return
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
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		invitedBy = &uc.ID
	}

	user, err := h.userStore.CreateUser(req.Email, req.Username, req.Password, req.Role, invitedBy)
	if err != nil {
		log.Printf("failed to create user: %v", err)
		http.Error(w, `{"error":"failed to create user"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("user invited: %s (%s) role=%s", user.Username, user.Email, user.Role)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toUserResponse(user))
}

// HandleUsers dispatches GET /api/admin/users and DELETE /api/admin/users?id=.
func (h *AdminHandler) HandleUsers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listUsers(w, r)
	case http.MethodDelete:
		h.deleteUser(w, r)
	case http.MethodPut:
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

	resp := make([]userResponse, 0, len(users))
	for i := range users {
		resp = append(resp, toUserResponse(&users[i]))
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
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

	// Prevent deleting the last admin
	if err := h.ensureNotLastAdmin(id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusBadRequest)
		return
	}

	if err := h.userStore.DeleteUser(id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	log.Printf("user deleted: id=%d", id)

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
	if req.Role != "admin" && req.Role != "collaborator" {
		http.Error(w, `{"error":"role must be admin or collaborator"}`, http.StatusBadRequest)
		return
	}

	// If demoting to collaborator, check it's not the last admin
	if req.Role == "collaborator" {
		if err := h.ensureNotLastAdmin(id); err != nil {
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

// HandleGrants dispatches POST/GET/DELETE /api/admin/grants.
func (h *AdminHandler) HandleGrants(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		h.createGrant(w, r)
	case http.MethodGet:
		h.listGrants(w, r)
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

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(toGrantResponse(grant))
}

func (h *AdminHandler) listGrants(w http.ResponseWriter, r *http.Request) {
	userIDStr := r.URL.Query().Get("user_id")
	ns := r.URL.Query().Get("namespace")

	var grants []store.Grant
	var err error

	if userIDStr != "" {
		userID, parseErr := strconv.Atoi(userIDStr)
		if parseErr != nil {
			http.Error(w, `{"error":"invalid user_id"}`, http.StatusBadRequest)
			return
		}
		grants, err = h.grantStore.GetGrantsForUser(userID)
	} else if ns != "" {
		grants, err = h.grantStore.GetGrantsForNamespace(ns)
	} else {
		http.Error(w, `{"error":"user_id or namespace query param required"}`, http.StatusBadRequest)
		return
	}

	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	resp := make([]grantResponse, 0, len(grants))
	for i := range grants {
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

	if err := h.grantStore.DeleteGrant(id); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	log.Printf("grant deleted: id=%d", id)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

// ensureNotLastAdmin returns an error if deleting/demoting the user would
// leave no admins.
func (h *AdminHandler) ensureNotLastAdmin(userID int) error {
	user, err := h.userStore.GetUserByID(userID)
	if err != nil || user == nil {
		return nil // not found is fine, delete will handle it
	}
	if user.Role != "admin" {
		return nil // not an admin, no concern
	}

	// Count remaining admins
	users, err := h.userStore.ListUsers()
	if err != nil {
		return err
	}
	adminCount := 0
	for _, u := range users {
		if u.Role == "admin" {
			adminCount++
		}
	}
	if adminCount <= 1 {
		return fmt.Errorf("cannot remove the last admin")
	}
	return nil
}
