package store

import (
	"database/sql"
	"fmt"
	"time"
)

// Note activity actions recorded in the note_activity table.
const (
	NoteActionCreated = "created"
	NoteActionEdited  = "edited"
)

// NoteContributor is a person who touched a note, with the time of the activity
// being reported (creation time, last-edit time, or their own most recent
// touch, depending on the field it appears in).
type NoteContributor struct {
	UserID   int    `json:"user_id"`
	Username string `json:"username"`
	At       string `json:"at"`
}

// NoteAttribution summarises who created a note, who last edited it, and every
// distinct person who has contributed. Created/LastEdited are nil when the note
// predates the activity trail (no rows yet).
type NoteAttribution struct {
	Created      *NoteContributor  `json:"created,omitempty"`
	LastEdited   *NoteContributor  `json:"last_edited,omitempty"`
	Contributors []NoteContributor `json:"contributors"`
}

// NoteActivityStore records and summarises per-note authorship. It is the
// authoritative "internal blame": every save appends a row, so attribution does
// not depend on git history (which is bot-authored and commit-batched).
type NoteActivityStore interface {
	// Record appends one activity row. userID <= 0 and noteID == "" are stored
	// as NULL. A failure here must never fail the underlying save — callers log
	// and continue.
	Record(namespace, path, noteID string, userID int, action string) error
	// Summary returns the created / last-edited / contributors view for a note.
	Summary(namespace, path string) (*NoteAttribution, error)
}

// PostgresNoteActivityStore implements NoteActivityStore against Postgres.
type PostgresNoteActivityStore struct {
	db *DB
}

// NewPostgresNoteActivityStore creates a new PostgresNoteActivityStore.
func NewPostgresNoteActivityStore(db *DB) *PostgresNoteActivityStore {
	return &PostgresNoteActivityStore{db: db}
}

func (s *PostgresNoteActivityStore) Record(namespace, path, noteID string, userID int, action string) error {
	var uid any
	if userID > 0 {
		uid = userID
	}
	var note any
	if noteID != "" {
		note = noteID
	}
	if _, err := s.db.Exec(
		`INSERT INTO note_activity (namespace, path, note_id, user_id, action)
		 VALUES ($1, $2, $3, $4, $5)`,
		namespace, path, note, uid, action,
	); err != nil {
		return fmt.Errorf("record note activity: %w", err)
	}
	return nil
}

func (s *PostgresNoteActivityStore) Summary(namespace, path string) (*NoteAttribution, error) {
	att := &NoteAttribution{Contributors: []NoteContributor{}}

	// Created: the first explicit "created" row, falling back to the earliest
	// activity of any kind when the note has no recorded creation (e.g. it was
	// authored before this feature existed but has been edited since).
	created, err := s.firstContributor(namespace, path,
		`SELECT na.user_id, u.username, na.created_at
		   FROM note_activity na JOIN users u ON u.id = na.user_id
		  WHERE na.namespace = $1 AND na.path = $2 AND na.action = $3
		  ORDER BY na.created_at ASC LIMIT 1`,
		namespace, path, NoteActionCreated)
	if err != nil {
		return nil, err
	}
	if created == nil {
		created, err = s.firstContributor(namespace, path,
			`SELECT na.user_id, u.username, na.created_at
			   FROM note_activity na JOIN users u ON u.id = na.user_id
			  WHERE na.namespace = $1 AND na.path = $2
			  ORDER BY na.created_at ASC LIMIT 1`,
			namespace, path)
		if err != nil {
			return nil, err
		}
	}
	att.Created = created

	// Last edited: the most recent activity by a named user.
	lastEdited, err := s.firstContributor(namespace, path,
		`SELECT na.user_id, u.username, na.created_at
		   FROM note_activity na JOIN users u ON u.id = na.user_id
		  WHERE na.namespace = $1 AND na.path = $2
		  ORDER BY na.created_at DESC LIMIT 1`,
		namespace, path)
	if err != nil {
		return nil, err
	}
	att.LastEdited = lastEdited

	// Contributors: every distinct named user, most-recently-active first.
	rows, err := s.db.Query(
		`SELECT u.id, u.username, MAX(na.created_at) AS last_at
		   FROM note_activity na JOIN users u ON u.id = na.user_id
		  WHERE na.namespace = $1 AND na.path = $2
		  GROUP BY u.id, u.username
		  ORDER BY last_at DESC`,
		namespace, path,
	)
	if err != nil {
		return nil, fmt.Errorf("note contributors: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var c NoteContributor
		var at time.Time
		if err := rows.Scan(&c.UserID, &c.Username, &at); err != nil {
			return nil, fmt.Errorf("scan contributor: %w", err)
		}
		c.At = at.UTC().Format(time.RFC3339)
		att.Contributors = append(att.Contributors, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate contributors: %w", err)
	}
	return att, nil
}

// firstContributor runs a query expected to return a single (user_id, username,
// created_at) row and maps it to a NoteContributor. Returns (nil, nil) when the
// query yields no rows.
func (s *PostgresNoteActivityStore) firstContributor(namespace, path, query string, args ...any) (*NoteContributor, error) {
	var c NoteContributor
	var at time.Time
	err := s.db.QueryRow(query, args...).Scan(&c.UserID, &c.Username, &at)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("note contributor: %w", err)
	}
	c.At = at.UTC().Format(time.RFC3339)
	return &c, nil
}
