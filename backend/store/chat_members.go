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
// the routes that move or copy notes call CopyPrefix, which also covers every
// chat inside a folder.
//
// Rows are never removed when a chat is moved away or deleted. The old path
// keeps its restriction, because the chat's git history is still served
// there (note history, note at a commit). The permission checker ignores such
// rows for folder operations once no file is at the path.
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
	// Invite adds target (if > 0) to the chat on behalf of caller, deciding
	// under a lock whether caller may: on a private chat caller must be on
	// the list now, not when the request was authorised (a member removed
	// in between must not be able to add themselves back); on an open chat
	// caller must be allowed to make it private (mayOpen), and is added
	// first. Returns ErrChatNotAllowed when caller may not.
	Invite(ns, path string, caller, target int, mayOpen bool) error
	// Remove takes userID off the list, unless they are the last member: a
	// private chat with nobody on it could never be opened again. Returns
	// ErrLastChatMember in that case.
	Remove(ns, path string, userID int) error
	// CopyPrefix gives the chat at to (or every chat under the folder to) the
	// member list of the matching chat under from, REPLACING whatever list
	// was at each destination path, so an old list left at a path cannot
	// add people back. It returns what it replaced, for RestoreCopy.
	CopyPrefix(fromNS, from, toNS, to string) (*ChatCopy, error)
	// RestoreCopy undoes a CopyPrefix whose move then failed: it removes the
	// rows the copy wrote and puts back the ones it replaced, and touches
	// nothing else.
	RestoreCopy(c *ChatCopy) error
}

// ChatCopy records what one CopyPrefix changed, so it can be undone exactly.
type ChatCopy struct {
	NS       string
	Paths    []string        // destination paths the copy wrote
	Replaced []ChatMemberRow // rows that were at those paths before
}

// ChatMemberRow is one raw chat_members row.
type ChatMemberRow struct {
	Path    string
	UserID  int
	AddedBy sql.NullInt64
	AddedAt sql.NullTime
}

// ErrChatNotAllowed is returned by Invite when the caller may not add.
var ErrChatNotAllowed = errChatNotAllowed{}

type errChatNotAllowed struct{}

func (errChatNotAllowed) Error() string { return "not allowed to change this chat's members" }

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
	p := canonChatPath(path)
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

// canonChatPath is the stored key: "/" + the path, LOWERCASED. Mounts can be
// case-insensitive (Docker Desktop on macOS, SMB), so CHATS/SECRET.md opens
// the same file as Chats/secret.md, and a case-sensitive key would let the
// first spelling skip the member check. On a case-sensitive disk two files
// that differ only in case share one list, which restricts more, never less.
// The permission checker folds paths the same way (middleware.foldPath).
func canonChatPath(p string) string { return strings.ToLower("/" + strings.Trim(p, "/")) }

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

func (s *PostgresChatMemberStore) Invite(ns, path string, caller, target int, mayOpen bool) error {
	key := canonChatPath(path)
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// An advisory lock per chat, because FOR UPDATE locks nothing on an
	// empty (open) list. Remove takes the same lock.
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, ns+key); err != nil {
		return err
	}
	rows, err := tx.Query(`SELECT user_id FROM chat_members WHERE namespace = $1 AND path = $2`, ns, key)
	if err != nil {
		return err
	}
	var ids []int
	for rows.Next() {
		var id int
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	isMember := false
	for _, id := range ids {
		isMember = isMember || id == caller
	}
	switch {
	case len(ids) == 0 && !mayOpen, len(ids) > 0 && !isMember:
		return ErrChatNotAllowed
	}
	add := []int{}
	if len(ids) == 0 {
		add = append(add, caller)
	}
	if target > 0 && target != caller {
		add = append(add, target)
	}
	for _, id := range add {
		if _, err := tx.Exec(`INSERT INTO chat_members (namespace, path, user_id, added_by)
			VALUES ($1, $2, $3, $4) ON CONFLICT (namespace, path, user_id) DO NOTHING`, ns, key, id, caller); err != nil {
			return err
		}
	}
	return tx.Commit()
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
	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock(hashtext($1))`, ns+canonChatPath(path)); err != nil {
		return err
	}
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

func (s *PostgresChatMemberStore) CopyPrefix(fromNS, from, toNS, to string) (*ChatCopy, error) {
	f, t := canonChatPath(from), canonChatPath(to)
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	frag, args := prefixMatch(from)
	rows, err := tx.Query(`SELECT path, user_id, added_by, added_at FROM chat_members
		WHERE namespace = $1 AND `+bind(frag, 2), append([]any{fromNS}, args...)...)
	if err != nil {
		return nil, err
	}
	src, err := scanRows(rows)
	if err != nil {
		return nil, err
	}
	c := &ChatCopy{NS: toNS}
	if len(src) == 0 {
		return c, nil
	}
	seen := map[string]bool{}
	for i := range src {
		src[i].Path = t + strings.TrimPrefix(src[i].Path, f)
		if !seen[src[i].Path] {
			seen[src[i].Path] = true
			c.Paths = append(c.Paths, src[i].Path)
		}
	}
	// Lock and remember what is there now, then replace it.
	rows, err = tx.Query(`SELECT path, user_id, added_by, added_at FROM chat_members
		WHERE namespace = $1 AND path = ANY($2) FOR UPDATE`, toNS, c.Paths)
	if err != nil {
		return nil, err
	}
	if c.Replaced, err = scanRows(rows); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(`DELETE FROM chat_members WHERE namespace = $1 AND path = ANY($2)`, toNS, c.Paths); err != nil {
		return nil, err
	}
	if err := insertRows(tx, toNS, src); err != nil {
		return nil, err
	}
	return c, tx.Commit()
}

func (s *PostgresChatMemberStore) RestoreCopy(c *ChatCopy) error {
	if c == nil || len(c.Paths) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM chat_members WHERE namespace = $1 AND path = ANY($2)`, c.NS, c.Paths); err != nil {
		return err
	}
	if err := insertRows(tx, c.NS, c.Replaced); err != nil {
		return err
	}
	return tx.Commit()
}

func scanRows(rows *sql.Rows) ([]ChatMemberRow, error) {
	defer rows.Close()
	var out []ChatMemberRow
	for rows.Next() {
		var r ChatMemberRow
		if err := rows.Scan(&r.Path, &r.UserID, &r.AddedBy, &r.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func insertRows(tx *sql.Tx, ns string, rows []ChatMemberRow) error {
	for _, r := range rows {
		at := any(nil)
		if r.AddedAt.Valid {
			at = r.AddedAt.Time
		}
		if _, err := tx.Exec(`INSERT INTO chat_members (namespace, path, user_id, added_by, added_at)
			VALUES ($1, $2, $3, $4, COALESCE($5, now()))
			ON CONFLICT (namespace, path, user_id) DO NOTHING`,
			ns, r.Path, r.UserID, r.AddedBy, at); err != nil {
			return err
		}
	}
	return nil
}
