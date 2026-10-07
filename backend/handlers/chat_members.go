package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// Private chats (issue #127). Routes, multi mode only:
//
//	GET    /api/chat/members?ns=&path=            {"private":bool,"members":[...]}
//	POST   /api/chat/members?ns=&path=            body {"userId":N} (optional)
//	DELETE /api/chat/members?ns=&path=&userId=N
//
// A chat with no member list is open, as before. POST on an open chat makes it
// private, with the caller as the first member (and userId, if given, as the
// second). POST on a private chat adds userId. Any member can add or remove
// anyone, including themselves; the last member cannot be removed, because a
// private chat with nobody on it could never be opened again.
//
// The routes only check note access. Membership itself is enforced by the
// permission checker on every route that serves the note, so a non-member
// gets a 403 here before the handler runs, and the handler never needs to ask.

// chatUserLookup is the part of the user store the member routes need.
type chatUserLookup interface {
	GetUserByID(id int) (*store.User, error)
}

// SetMembers turns on private chats. users resolves the id being added, so a
// typo cannot put a nonexistent account on a chat.
func (h *ChatHandler) SetMembers(m store.ChatMemberStore, users chatUserLookup) {
	h.members = m
	h.users = users
}

// MembersEnabled reports whether private chats are on.
func (h *ChatHandler) MembersEnabled() bool { return h.members != nil }

func (h *ChatHandler) HandleMembers(w http.ResponseWriter, r *http.Request) {
	if h.members == nil {
		chatJSONError(w, http.StatusNotFound, "private chats are not available")
		return
	}
	uc := middleware.UserFromContext(r.Context())
	if uc == nil || uc.ID <= 0 {
		chatJSONError(w, http.StatusForbidden, "private chats need a signed-in user")
		return
	}
	ns, relPath, ok := h.chatTarget(w, r)
	if !ok {
		return
	}
	if !h.headIsChat(r.Context(), ns, relPath) {
		chatJSONError(w, http.StatusBadRequest, "not a chat")
		return
	}
	key := "/" + relPath

	switch r.Method {
	case http.MethodGet:
		h.writeMembers(w, ns, key)

	case http.MethodPost:
		var body struct {
			UserID int `json:"userId"`
		}
		if raw, err := io.ReadAll(io.LimitReader(r.Body, 4096)); err == nil && len(raw) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				chatJSONError(w, http.StatusBadRequest, "invalid body")
				return
			}
		}
		if body.UserID < 0 {
			chatJSONError(w, http.StatusBadRequest, "invalid userId")
			return
		}
		if body.UserID > 0 {
			if u, err := h.users.GetUserByID(body.UserID); err != nil || u == nil {
				chatJSONError(w, http.StatusNotFound, "user not found")
				return
			}
		}
		// The caller first. On an open chat this is what makes it private,
		// and it means the person who closed it can always still open it.
		// On a private chat the caller is already a member (the checker let
		// them in), so this is a no-op.
		if err := h.members.Add(ns, key, uc.ID, uc.ID); err != nil {
			chatJSONError(w, http.StatusInternalServerError, "failed to update members")
			return
		}
		if body.UserID > 0 && body.UserID != uc.ID {
			if err := h.members.Add(ns, key, body.UserID, uc.ID); err != nil {
				chatJSONError(w, http.StatusInternalServerError, "failed to update members")
				return
			}
		}
		h.writeMembers(w, ns, key)

	case http.MethodDelete:
		id, err := strconv.Atoi(r.URL.Query().Get("userId"))
		if err != nil || id <= 0 {
			chatJSONError(w, http.StatusBadRequest, "userId is required")
			return
		}
		if err := h.members.Remove(ns, key, id); err != nil {
			if errors.Is(err, store.ErrLastChatMember) {
				chatJSONError(w, http.StatusConflict, err.Error())
				return
			}
			chatJSONError(w, http.StatusInternalServerError, "failed to update members")
			return
		}
		h.writeMembers(w, ns, key)

	default:
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *ChatHandler) writeMembers(w http.ResponseWriter, ns, key string) {
	list, err := h.members.List(ns, key)
	if err != nil {
		chatJSONError(w, http.StatusInternalServerError, "failed to read members")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"private": len(list) > 0, "members": list})
}
