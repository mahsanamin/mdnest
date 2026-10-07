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

// chatUserLookup lists the people who can be invited to a chat in a
// namespace: the same list the picker shows (/api/namespace/users).
type chatUserLookup interface {
	UsersForNamespace(namespace string) ([]store.NamespaceUser, error)
}

// SetMembers turns on private chats. users bounds who can be invited: only
// someone with a grant in the chat's workspace. Accepting any account id
// would let a member put arbitrary accounts on a chat, and learn the username
// behind every id on the server from the list it sends back.
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
	if r.Method == http.MethodPost && !PrivateChatPathOK(relPath) {
		chatJSONError(w, http.StatusBadRequest, "a private chat needs a plain ASCII path; rename it first")
		return
	}
	// The list is keyed by the lowercased path, so it would also cover any
	// other file whose name differs only in letter case (case-sensitive disk).
	if r.Method == http.MethodPost && foldedMatches(r.Context(), h.store, ns, relPath) > 1 {
		chatJSONError(w, http.StatusConflict, "another note has this name in different letter case; rename one of them first")
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
		if body.UserID > 0 && body.UserID != uc.ID {
			inWorkspace := false
			if users, err := h.users.UsersForNamespace(ns); err == nil {
				for _, u := range users {
					inWorkspace = inWorkspace || u.ID == body.UserID
				}
			}
			if !inWorkspace {
				chatJSONError(w, http.StatusNotFound, "no such user in this workspace")
				return
			}
		}
		// Turning an OPEN chat private shuts out everyone not added, so it is
		// for a namespace admin. Otherwise anyone with write access could tag
		// any shared note as a chat and then hide it from everyone else. A
		// new chat can still be created private by anyone (convert
		// ?private=1), and on a private chat any member can invite. The
		// store decides under a lock, against the list as it is NOW: the
		// route's check ran earlier, and a member removed in between must
		// not be able to add themselves back.
		pc := middleware.CheckerFrom(r.Context())
		mayOpen := pc != nil && pc.HasAdminScope(uc, ns)
		if err := h.members.Invite(ns, key, uc.ID, body.UserID, mayOpen); err != nil {
			if errors.Is(err, store.ErrChatNotAllowed) {
				chatJSONError(w, http.StatusForbidden, "only a workspace admin can make an existing chat private; a new chat can be created private")
				return
			}
			chatJSONError(w, http.StatusInternalServerError, "failed to update members")
			return
		}
		h.dropNonMembers(ns, relPath, key)
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
		h.dropNonMembers(ns, relPath, key)
		h.writeMembers(w, ns, key)

	default:
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

// dropNonMembers closes the live-editing connections of anyone not on the
// list, after a removal or after an open chat was made private. Every other
// way of reading the chat is checked per request; a live connection is
// checked once, when it joins, so without this a removed member with the note
// open in the editor would keep receiving every new message.
func (h *ChatHandler) dropNonMembers(ns, relPath, key string) {
	if h.hub == nil {
		return
	}
	ids, err := h.members.Members(ns, key)
	if err != nil {
		// Cannot tell who is still in: drop everyone, they reconnect
		// through the permission check.
		h.hub.DropUsers(ns, relPath, func(int) bool { return false })
		return
	}
	h.hub.DropUsers(ns, relPath, func(uid int) bool { return containsInt(ids, uid) })
}

func containsInt(ids []int, id int) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
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
