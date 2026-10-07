package store

import (
	"database/sql"
	"strconv"
	"strings"
)

// ChatMember is one person on a private chat's member list.
type ChatMember struct {
	UserID   int    `json:"id"`
	Username string `json:"username"`
	AddedBy  *int   `json:"addedBy,omitempty"`
	AddedAt  string `json:"addedAt"`
}

// ChatMemberStore holds the member lists of private chats (issue #127).
//
// A chat with no rows is open: anyone with access to the note can read and
// post, as before. A chat with rows is private: the permission checker allows
// only the users listed, on every route that serves the note. Membership
// narrows access, it never grants it: a member still needs a grant on the note.
//
// Chats are addressed by namespace + canonical path ("/Chats/team.md"), the
// form the permission checker matches. The path is not stable on its own, so
// the routes that move, copy or delete notes call MovePrefix / CopyPrefix /
// DeletePrefix, which also cover every chat inside a folder.
type ChatMemberStore interface {
	// Members returns the member user IDs of the chat at ns/path. Empty means
	// the chat is open.
	Members(ns, path string) ([]int, error)
	// Restricted returns every private chat in ns with its member IDs, for
	// listings that check many paths at once.
	Restricted(ns string) (map[string][]int, error)
	// List returns the members of one chat with their usernames.
	List(ns, path string) ([]ChatMember, error)
	// Add puts userID on the chat's list. Adding someone already on it is a
	// no-op.
	Add(ns, path string, userID, addedBy int) error
	// Remove takes userID off the list, unless they are the last member: a
	// private chat with nobody on it could never be opened again. Returns
	// ErrLastChatMember in that case.
	Remove(ns, path string, userID int) error
	// MovePrefix re-addresses the chat at from, or every chat under the folder
	// from, to the same place under to.
	MovePrefix(fromNS, from, toNS, to string) error
	// CopyPrefix gives the copies made at to the same members as the chats
	// they were copied from, so a copy of a private chat is not open.
	CopyPrefix(fromNS, from, toNS, to string) error
	// DeletePrefix forgets the chat at path, or every chat under the folder.
	DeletePrefix(ns, path string) error
}

// ErrLastChatMember is returned by Remove for the last member of a chat.
var ErrLastChatMember = errLastChatMember{}

type errLastChatMember struct{}

func (errLastChatMember) Error() string { return "cannot remove the last member of a private chat" }

// PostgresChatMemberStore implements ChatMemberStore against Postgres.
type PostgresChatMemberStore struct {
	db *DB
}

// NewPostgresChatMemberStore creates a new PostgresChatMemberStore.
func NewPostgresChatMemberStore(db *DB) *PostgresChatMemberStore {
	return &PostgresChatMemberStore{db: db}
}

// prefixMatch is the WHERE fragment for "the path itself or anything under
// it". starts_with keeps a % or _ in a folder name literal, which LIKE would
// read as a wildcard. The namespace root covers the whole namespace.
func prefixMatch(path string) (string, []any) {
	p := "/" + strings.Trim(path, "/")
	if p == "/" {
		return "TRUE", nil
	}
	return "(path = $X OR starts_with(path, $Y))", []any{p, p + "/"}
}

// bind numbers the $X / $Y placeholders of a prefixMatch fragment from n.
func bind(frag string, n int) string {
	frag = strings.Replace(frag, "$X", "$"+strconv.Itoa(n), 1)
	return strings.Replace(frag, "$Y", "$"+strconv.Itoa(n+1), 1)
}

func canonChatPath(p string) string { return "/" + strings.Trim(p, "/") }

func (s *PostgresChatMemberStore) Members(ns, path string) ([]int, error) {
	rows, err := s.db.Query(`SELECT user_id FROM chat_members WHERE namespace = $1 AND path = $2`, ns, canonChatPath(path))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *PostgresChatMemberStore) Restricted(ns string) (map[string][]int, error) {
	rows, err := s.db.Query(`SELECT path, user_id FROM chat_members WHERE namespace = $1`, ns)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]int{}
	for rows.Next() {
		var p string
		var id int
		if err := rows.Scan(&p, &id); err != nil {
			return nil, err
		}
		out[p] = append(out[p], id)
	}
	return out, rows.Err()
}

func (s *PostgresChatMemberStore) List(ns, path string) ([]ChatMember, error) {
	rows, err := s.db.Query(`
		SELECT m.user_id, COALESCE(u.username, '(deleted user)'), m.added_by, m.added_at
		FROM chat_members m LEFT JOIN users u ON u.id = m.user_id
		WHERE m.namespace = $1 AND m.path = $2
		ORDER BY m.added_at, u.username`, ns, canonChatPath(path))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ChatMember{}
	for rows.Next() {
		var m ChatMember
		var by sql.NullInt64
		var at sql.NullTime
		if err := rows.Scan(&m.UserID, &m.Username, &by, &at); err != nil {
			return nil, err
		}
		if by.Valid {
			v := int(by.Int64)
			m.AddedBy = &v
		}
		if at.Valid {
			m.AddedAt = at.Time.UTC().Format("2006-01-02T15:04:05Z")
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *PostgresChatMemberStore) Add(ns, path string, userID, addedBy int) error {
	var by any
	if addedBy > 0 {
		by = addedBy
	}
	_, err := s.db.Exec(`
		INSERT INTO chat_members (namespace, path, user_id, added_by)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (namespace, path, user_id) DO NOTHING`, ns, canonChatPath(path), userID, by)
	return err
}

func (s *PostgresChatMemberStore) Remove(ns, path string, userID int) error {
	// Lock the chat's rows first. Two members removing each other at the same
	// moment would otherwise both see two members, both succeed, and leave a
	// chat nobody can open. The second transaction waits here and then sees
	// the list as the first one left it.
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query(`SELECT user_id FROM chat_members WHERE namespace = $1 AND path = $2 FOR UPDATE`,
		ns, canonChatPath(path))
	if err != nil {
		return err
	}
	found, count := false, 0
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		count++
		found = found || id == userID
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if !found {
		return nil
	}
	if count == 1 {
		return ErrLastChatMember
	}
	if _, err := tx.Exec(`DELETE FROM chat_members WHERE namespace = $1 AND path = $2 AND user_id = $3`,
		ns, canonChatPath(path), userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PostgresChatMemberStore) MovePrefix(fromNS, from, toNS, to string) error {
	frag, args := prefixMatch(from)
	f, t := canonChatPath(from), canonChatPath(to)
	q := `UPDATE chat_members SET namespace = $1, path = $2 || substr(path, $3)
		WHERE namespace = $4 AND ` + bind(frag, 5)
	_, err := s.db.Exec(q, append([]any{toNS, t, len(f) + 1, fromNS}, args...)...)
	return err
}

func (s *PostgresChatMemberStore) CopyPrefix(fromNS, from, toNS, to string) error {
	frag, args := prefixMatch(from)
	f, t := canonChatPath(from), canonChatPath(to)
	q := `INSERT INTO chat_members (namespace, path, user_id, added_by, added_at)
		SELECT $1, $2 || substr(path, $3), user_id, added_by, added_at
		FROM chat_members WHERE namespace = $4 AND ` + bind(frag, 5) + `
		ON CONFLICT (namespace, path, user_id) DO NOTHING`
	_, err := s.db.Exec(q, append([]any{toNS, t, len(f) + 1, fromNS}, args...)...)
	return err
}

func (s *PostgresChatMemberStore) DeletePrefix(ns, path string) error {
	frag, args := prefixMatch(path)
	_, err := s.db.Exec(`DELETE FROM chat_members WHERE namespace = $1 AND `+bind(frag, 2), append([]any{ns}, args...)...)
	return err
}
