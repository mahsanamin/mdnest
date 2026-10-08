package handlers

import (
	"context"
	"errors"
	"net/http"
	"path"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
)

// Who may delete a chat. A chat is shared history: everyone in it, people and
// agents, loses the conversation when it goes. So in multi mode only its
// owner (the account that created it), a namespace admin or a superadmin may
// remove it, whichever way the removal arrives: DELETE of the note or of a
// folder holding it, a cross-namespace move, an upload over it, or a PUT or
// prepend that would turn it back into an ordinary note (which anyone with
// write access could then delete). Single mode has one user, who may.
//
// The owner is the `owner:` front-matter line written when the chat is
// created. A chat made before that line existed is owned by the account of
// its first message, and one with neither (an empty legacy chat, nothing in
// it to lose) may be removed by anyone who can write it. Changing who the
// owner is falls under the same rule, so the line cannot simply be edited to
// someone else.

const chatOwnerKey = "owner"

const errChatOwnerOnly = "only the chat's owner or a workspace admin can delete this chat"

// ChatOwner returns the account that owns a chat note, or "" when it has none.
func ChatOwner(content string) string {
	fm, _, ok := splitFrontMatter(content)
	if !ok {
		return ""
	}
	if v, has := frontMatterValue(fm, chatOwnerKey); has {
		return sanitizeChatLabel(v)
	}
	doc := ParseChat(content)
	if len(doc.Messages) == 0 {
		return ""
	}
	first := doc.Messages[0]
	if first.Via != "" {
		return first.Via
	}
	return first.Author
}

// stampChatOwner adds an `owner:` line to a chat note that has none.
func stampChatOwner(content, owner string) string {
	owner = sanitizeChatLabel(owner)
	fm, rest, ok := splitFrontMatter(content)
	if owner == "" || !ok {
		return content
	}
	if _, has := frontMatterValue(fm, chatOwnerKey); has {
		return content
	}
	return "---\n" + strings.TrimRight(fm, "\n") + "\n" + chatOwnerKey + ": " + owner + "\n---\n" + rest
}

// requestOwnerName is the owner a chat created by this request gets: the
// account in multi mode, nobody in single mode.
func requestOwnerName(r *http.Request) string {
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		return sanitizeChatLabel(uc.Username)
	}
	return ""
}

// mayRemoveChat reports whether the caller may delete the chat whose content
// is given.
func mayRemoveChat(r *http.Request, ns, content string) bool {
	return mayRemoveOwnedBy(r, ns, ChatOwner(content))
}

// mayRemoveOwnedBy is mayRemoveChat for a chat whose owner is already known.
func mayRemoveOwnedBy(r *http.Request, ns, owner string) bool {
	uc := middleware.UserFromContext(r.Context())
	pc := middleware.CheckerFrom(r.Context())
	if uc == nil {
		// No user and no checker is single mode. A checker with no user is a
		// multi-mode token that maps to nobody: it owns nothing.
		return pc == nil
	}
	if pc != nil && pc.HasAdminScope(uc, ns) {
		return true
	}
	return owner == "" || strings.EqualFold(owner, sanitizeChatLabel(uc.Username))
}

// chatEditAllowed reports whether replacing a note's content `before` with
// `after` is allowed: anyone who can write a chat can edit it, but only those
// who may delete it can turn it into a plain note or change its owner.
func chatEditAllowed(r *http.Request, ns, before, after string) bool {
	if !IsChatNote(before) {
		return true
	}
	if IsChatNote(after) && ChatOwner(after) == ChatOwner(before) {
		return true
	}
	return mayRemoveChat(r, ns, before)
}

// readChatFile reads of a markdown file to see whether it is a chat.
// An error reads as "not a chat": the caller's own removal then fails or
// succeeds on its own terms.
func readChatFile(ctx context.Context, st storage.Storage, ns, relPath string) (string, bool) {
	if !strings.HasSuffix(strings.ToLower(relPath), ".md") {
		return "", false
	}
	data, err := st.ReadFile(ctx, ns, relPath)
	if err != nil || !IsChatNote(string(data)) {
		return "", false
	}
	return string(data), true
}

// blockedChat returns the first chat at or under relPath that the caller may
// not delete, or "" when the removal may go ahead.
func blockedChat(r *http.Request, st storage.Storage, ns, relPath string, isDir bool) string {
	ctx := r.Context()
	if !isDir {
		if content, ok := readChatFile(ctx, st, ns, relPath); ok && !mayRemoveChat(r, ns, content) {
			return relPath
		}
		return ""
	}
	blocked := ""
	errFound := errors.New("found")
	st.Walk(ctx, ns, relPath, func(p string, info storage.FileInfo) error {
		// A link is removed as itself, never its target, so it is not checked.
		if info.IsDir || info.IsSymlink {
			return nil
		}
		if content, ok := readChatFile(ctx, st, ns, p); ok && !mayRemoveChat(r, ns, content) {
			blocked = p
			return errFound
		}
		return nil
	})
	return blocked
}

// denyChatRemoval writes the 403 for blockedChat's answer.
func denyChatRemoval(w http.ResponseWriter, blocked string, isDir bool) {
	msg := errChatOwnerOnly
	if isDir {
		msg = "this folder holds a chat (" + path.Base(blocked) + ") that only its owner or a workspace admin can delete"
	}
	chatJSONError(w, http.StatusForbidden, msg)
}
