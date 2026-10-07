package handlers

import (
	"log"

	"github.com/mdnest/mdnest/backend/store"
)

// Private chats (issue #127) are keyed by note path, so a route that moves or
// copies notes has to take the member lists along. These helpers are the one
// place that order is decided.
//
// The lists go to the destination BEFORE the files do. The other order would
// leave a window, or after a failed update a permanent state, in which the
// chat sits at its new path with no list, which means open to everyone.
//
// Nothing is removed from the source, on a move or on a delete. The chat's
// git history is still served at its old path, so the old path stays
// restricted (the permission checker ignores such rows for folder operations
// once no file is there).
//
// A failed move undoes exactly what the copy wrote and nothing else. An
// earlier version dropped every list under the destination, and a move aimed
// at an existing folder (which fails) wiped the list of a private chat that
// already lived there.

// chatMembersFollow is the part of store.ChatMemberStore these routes need.
// Nil (single mode, or no database) turns every helper into a no-op.
type chatMembersFollow interface {
	CopyPrefix(fromNS, from, toNS, to string) (*store.ChatCopy, error)
	RestoreCopy(c *store.ChatCopy) error
}

// chatMembersBeforeMove copies the member lists under from to the same
// places under to. ok false means the move must not go ahead. The returned
// copy is handed to chatMembersAfter.
func chatMembersBeforeMove(m chatMembersFollow, fromNS, from, toNS, to string) (*store.ChatCopy, bool) {
	if m == nil {
		return nil, true
	}
	c, err := m.CopyPrefix(fromNS, "/"+from, toNS, "/"+to)
	if err != nil {
		log.Printf("chat members: copy %s/%s -> %s/%s: %v", fromNS, from, toNS, to, err)
		return nil, false
	}
	return c, true
}

// chatMembersAfter undoes the copy if the files did not move.
func chatMembersAfter(m chatMembersFollow, c *store.ChatCopy, ok bool) {
	if m == nil || ok || c == nil {
		return
	}
	if err := m.RestoreCopy(c); err != nil {
		// Left behind: a restriction on a path that has no chat. It
		// refuses rather than opens, so log and carry on.
		log.Printf("chat members: undo copy in %s: %v", c.NS, err)
	}
}

var _ chatMembersFollow = (store.ChatMemberStore)(nil)
