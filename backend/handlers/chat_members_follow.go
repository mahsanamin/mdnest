package handlers

import (
	"context"
	"errors"
	"log"
	"strings"

	"github.com/mdnest/mdnest/backend/storage"
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

// PrivateChatPathOK reports whether p may hold a private chat: plain ASCII.
// Member lists are keyed by the lowercased path, which matches how a
// case-insensitive disk compares ASCII names but not every other letter, so
// a private chat at a non-ASCII path could be reached by a spelling that
// misses its key (see middleware exactSpelling).
func PrivateChatPathOK(p string) bool {
	for i := 0; i < len(p); i++ {
		if p[i] >= 0x80 {
			return false
		}
	}
	return true
}

// foldedMatches counts the files and folders whose path equals rel when
// letter case is ignored, including rel itself. Member lists are keyed by the
// lowercased path, so on a case-sensitive disk Shared/DOC.md and an existing
// Shared/doc.md share one key: a list written for the first would also lock
// everyone out of the second. Callers refuse to write a list when the count
// says another spelling is there. An I/O error counts as a match, so a doubt
// refuses.
func foldedMatches(ctx context.Context, stg storage.Storage, ns, rel string) int {
	paths := []string{""}
	for _, seg := range strings.Split(strings.Trim(rel, "/"), "/") {
		var next []string
		for _, dir := range paths {
			entries, err := stg.ReadDir(ctx, ns, dir)
			if err != nil {
				if errors.Is(err, storage.ErrNotExist) {
					continue
				}
				return 2
			}
			for _, e := range entries {
				if strings.EqualFold(e.Name, seg) {
					next = append(next, strings.TrimPrefix(dir+"/"+e.Name, "/"))
				}
			}
		}
		if len(next) == 0 {
			return 0
		}
		paths = next
	}
	return len(paths)
}

// chatMembersFollow is the part of store.ChatMemberStore these routes need.
// Nil (single mode, or no database) turns every helper into a no-op.
type chatMembersFollow interface {
	CopyPrefix(fromNS, from, toNS, to string) (*store.ChatCopy, error)
	RestoreCopy(c *store.ChatCopy) error
}

// chatMembersBeforeMove copies the member lists under from to the same
// places under to. ok false means the move must not go ahead. The returned
// copy is handed to chatMembersAfter.
func chatMembersBeforeMove(ctx context.Context, stg storage.Storage, m chatMembersFollow, fromNS, from, toNS, to string) (*store.ChatCopy, bool) {
	if m == nil {
		return nil, true
	}
	c, err := m.CopyPrefix(fromNS, "/"+from, toNS, "/"+to)
	if err == nil && len(c.Paths) > 0 && !(fromNS == toNS && strings.EqualFold(from, to)) {
		// The destination does not exist yet, so any file that folds to a
		// key just written is a different spelling, and the list would
		// lock everyone out of it. A case-only rename is the same file.
		for _, key := range c.Paths {
			if foldedMatches(ctx, stg, toNS, key) > 0 {
				_ = m.RestoreCopy(c)
				log.Printf("chat members: refused, %s%s is taken by another spelling", toNS, key)
				return nil, false
			}
		}
	}
	if err == nil && len(c.Paths) > 0 && !PrivateChatPathOK(to) {
		// A private chat would land at a non-ASCII path: undo and refuse.
		_ = m.RestoreCopy(c)
		log.Printf("chat members: refused to carry private chats to non-ASCII %s/%s", toNS, to)
		return nil, false
	}
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
