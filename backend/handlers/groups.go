package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// GroupsHandler manages role-based access "Groups": named sets of users and/or
// IdP (OIDC) group IDs, each carrying namespace grants. Superadmin-only; the
// routes are gated with RequireSuperAdmin in main.go.
type GroupsHandler struct {
	groups store.GroupStore
}

// NewGroupsHandler builds a GroupsHandler.
func NewGroupsHandler(groups store.GroupStore) *GroupsHandler {
	return &GroupsHandler{groups: groups}
}

type groupResponse struct {
	ID          int    `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type groupMemberResponse struct {
	UserID    *int    `json:"user_id,omitempty"`
	Username  string  `json:"username,omitempty"`
	OIDCGroup *string `json:"oidc_group,omitempty"`
	OIDCLabel string  `json:"oidc_label,omitempty"`
}

type groupGrantResponse struct {
	ID         int    `json:"id"`
	GroupID    int    `json:"group_id"`
	Namespace  string `json:"namespace"`
	Path       string `json:"path"`
	Permission string `json:"permission"`
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// HandleGroups is /api/admin/groups — CRUD over the group definitions.
func (h *GroupsHandler) HandleGroups(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		groups, err := h.groups.ListGroups()
		if err != nil {
			log.Printf("list groups: %v", err)
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		resp := make([]groupResponse, 0, len(groups))
		for _, g := range groups {
			resp = append(resp, groupResponse{ID: g.ID, Name: g.Name, Description: g.Description})
		}
		writeJSON(w, resp)

	case http.MethodPost:
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
			return
		}
		g, err := h.groups.CreateGroup(req.Name, req.Description)
		if err != nil {
			http.Error(w, `{"error":"could not create group (name required and unique)"}`, http.StatusBadRequest)
			return
		}
		writeJSON(w, groupResponse{ID: g.ID, Name: g.Name, Description: g.Description})

	case http.MethodPut:
		var req struct {
			ID          int    `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == 0 {
			http.Error(w, `{"error":"id and name are required"}`, http.StatusBadRequest)
			return
		}
		if err := h.groups.UpdateGroup(req.ID, req.Name, req.Description); err != nil {
			http.Error(w, `{"error":"could not update group"}`, http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case http.MethodDelete:
		id, ok := intQuery(r, "id")
		if !ok {
			http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
			return
		}
		if err := h.groups.DeleteGroup(id); err != nil {
			http.Error(w, `{"error":"could not delete group"}`, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// HandleMembers is /api/admin/groups/members — list/add/remove members.
func (h *GroupsHandler) HandleMembers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		gid, ok := intQuery(r, "group_id")
		if !ok {
			http.Error(w, `{"error":"group_id is required"}`, http.StatusBadRequest)
			return
		}
		members, err := h.groups.ListMembers(gid)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		resp := make([]groupMemberResponse, 0, len(members))
		for _, m := range members {
			resp = append(resp, groupMemberResponse{
				UserID:    m.UserID,
				Username:  m.Username,
				OIDCGroup: m.OIDCGroup,
				OIDCLabel: m.OIDCLabel,
			})
		}
		writeJSON(w, resp)

	case http.MethodPost:
		var req struct {
			GroupID   int    `json:"group_id"`
			UserID    *int   `json:"user_id"`
			OIDCGroup string `json:"oidc_group"`
			OIDCLabel string `json:"oidc_label"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.GroupID == 0 {
			http.Error(w, `{"error":"group_id and one of user_id / oidc_group are required"}`, http.StatusBadRequest)
			return
		}
		switch {
		case req.UserID != nil:
			if err := h.groups.AddUserMember(req.GroupID, *req.UserID); err != nil {
				http.Error(w, `{"error":"could not add user member"}`, http.StatusBadRequest)
				return
			}
		case req.OIDCGroup != "":
			if err := h.groups.AddOIDCMember(req.GroupID, req.OIDCGroup, req.OIDCLabel); err != nil {
				http.Error(w, `{"error":"could not add oidc group member"}`, http.StatusBadRequest)
				return
			}
		default:
			http.Error(w, `{"error":"one of user_id / oidc_group is required"}`, http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case http.MethodDelete:
		gid, ok := intQuery(r, "group_id")
		if !ok {
			http.Error(w, `{"error":"group_id is required"}`, http.StatusBadRequest)
			return
		}
		if uid, ok := intQuery(r, "user_id"); ok {
			if err := h.groups.RemoveUserMember(gid, uid); err != nil {
				http.Error(w, `{"error":"could not remove member"}`, http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if oidc := r.URL.Query().Get("oidc_group"); oidc != "" {
			if err := h.groups.RemoveOIDCMember(gid, oidc); err != nil {
				http.Error(w, `{"error":"could not remove member"}`, http.StatusInternalServerError)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		http.Error(w, `{"error":"user_id or oidc_group is required"}`, http.StatusBadRequest)

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// HandleGrants is /api/admin/groups/grants — list/add/update/remove the
// namespace grants attached to a group.
func (h *GroupsHandler) HandleGrants(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		gid, ok := intQuery(r, "group_id")
		if !ok {
			http.Error(w, `{"error":"group_id is required"}`, http.StatusBadRequest)
			return
		}
		grants, err := h.groups.ListGrantsForGroup(gid)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		resp := make([]groupGrantResponse, 0, len(grants))
		for _, g := range grants {
			resp = append(resp, groupGrantResponse{
				ID: g.ID, GroupID: g.GroupID, Namespace: g.Namespace, Path: g.Path, Permission: g.Permission,
			})
		}
		writeJSON(w, resp)

	case http.MethodPost:
		var req struct {
			GroupID    int    `json:"group_id"`
			Namespace  string `json:"namespace"`
			Path       string `json:"path"`
			Permission string `json:"permission"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.GroupID == 0 || req.Namespace == "" {
			http.Error(w, `{"error":"group_id and namespace are required"}`, http.StatusBadRequest)
			return
		}
		g, err := h.groups.CreateGroupGrant(req.GroupID, req.Namespace, req.Path, req.Permission, callerID(r))
		if err != nil {
			http.Error(w, `{"error":"could not create grant"}`, http.StatusBadRequest)
			return
		}
		writeJSON(w, groupGrantResponse{ID: g.ID, GroupID: g.GroupID, Namespace: g.Namespace, Path: g.Path, Permission: g.Permission})

	case http.MethodPut:
		var req struct {
			ID         int    `json:"id"`
			Permission string `json:"permission"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ID == 0 {
			http.Error(w, `{"error":"id and permission are required"}`, http.StatusBadRequest)
			return
		}
		if err := h.groups.UpdateGroupGrantPermission(req.ID, req.Permission); err != nil {
			http.Error(w, `{"error":"could not update grant"}`, http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case http.MethodDelete:
		id, ok := intQuery(r, "id")
		if !ok {
			http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
			return
		}
		if err := h.groups.DeleteGroupGrant(id); err != nil {
			http.Error(w, `{"error":"could not delete grant"}`, http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func intQuery(r *http.Request, key string) (int, bool) {
	s := r.URL.Query().Get(key)
	if s == "" {
		return 0, false
	}
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0, false
	}
	return v, true
}

func callerID(r *http.Request) *int {
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		id := uc.ID
		return &id
	}
	return nil
}
