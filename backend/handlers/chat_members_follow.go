package handlers

import (
	"log"

	"github.com/mdnest/mdnest/backend/store"
)

// Private chats (issue #127) are keyed by note path, so a route that moves,
// copies or deletes notes has to take the member lists along. These helpers
// are the one place that order is decided.
//
// The rows go to the destination BEFORE the files do. The other order would
// leave a window, or after a failed update a permanent state, in which the
// chat sits at its new path with no member list, which means open to
// everyone. A row for a path with no file grants nothing, so the only cost of
// a failure is a stale restriction, and that fails closed.

// chatMembersFollow is the part of store.ChatMemberStore these routes need.
// Nil (single mode, or no database) turns every helper into a no-op.
type chatMembersFollow interface {
	CopyPrefix(fromNS, from, toNS, to string) error
	DeletePrefix(ns, path string) error
}

// beforeMove copies the member lists under from to the same places under to.
// A false return means the transfer must not go ahead.
func chatMembersBeforeMove(m chatMembersFollow, fromNS, from, toNS, to string) bool {
	if m == nil {
		return true
	}
	if err := m.CopyPrefix(fromNS, "/"+from, toNS, "/"+to); err != nil {
		log.Printf("chat members: copy %s/%s -> %s/%s: %v", fromNS, from, toNS, to, err)
		return false
	}
	return true
}

// chatMembersAfter finishes what beforeMove started. ok is whether the files
// moved: if they did and the source is gone (a move), the old rows go; if they
// did not, the rows made for the destination go.
func chatMembersAfter(m chatMembersFollow, ok, sourceGone bool, fromNS, from, toNS, to string) {
	if m == nil {
		return
	}
	var err error
	switch {
	case !ok:
		err = m.DeletePrefix(toNS, "/"+to)
	case sourceGone:
		err = m.DeletePrefix(fromNS, "/"+from)
	}
	if err != nil {
		// Left behind: a restriction on a path that has no chat any more.
		// It refuses rather than opens, so log and carry on.
		log.Printf("chat members: tidy after %s/%s -> %s/%s: %v", fromNS, from, toNS, to, err)
	}
}

var _ chatMembersFollow = (store.ChatMemberStore)(nil)
