package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// Stickies are a personal scratch board — a handful of short notes a user keeps
// beside their workspace. They are NOT notes: they never appear in a namespace,
// never reach a git remote, and are not shared with anyone. That is the whole
// point of the feature, and it is the storage location that delivers it, not
// encryption: everything here lives in the secrets volume, which the git-sync
// sidecar (which walks /data/notes/*/) cannot see.
//
// The board is persisted whole, not per card. The API replaces the array on
// every change, so a row-per-card schema would buy nothing but a diffing
// problem and a concurrency question the feature does not have.

// Sticky is one card.
type Sticky struct {
	ID        string `json:"id"`
	Body      string `json:"body"`
	Done      bool   `json:"done"`
	Color     string `json:"color"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
}

// Limits, enforced by ValidateBoard on every write. They exist because the
// endpoint is writable by any authenticated user: without them a board is an
// unbounded per-user blob store, the same reasoning that gave preferences a
// key allowlist.
const (
	MaxStickies    = 200  // cards per board
	MaxStickyBody  = 4096 // bytes in one card
	MaxStickyID    = 64   // bytes in one card id
	MaxStickyBoard = 262144
)

// StickyColors is the palette a card may claim. The frontend only ever sends
// one of these; the server checks anyway, because the value ends up in a CSS
// class name and an open enum there is an injection surface for free.
var StickyColors = map[string]bool{
	"yellow": true,
	"pink":   true,
	"blue":   true,
	"green":  true,
	"grey":   true,
}

// ErrStickyBoard is the class of every validation failure below. Callers turn
// it into a 400; anything else is a 500.
var ErrStickyBoard = errors.New("invalid sticky board")

// ValidateBoard checks a board against the limits and normalises what it can.
// It returns a wrapped ErrStickyBoard naming the specific problem — the client
// shows that string, and "too many stickies" is actionable where "bad request"
// is not.
//
// Normalisation is deliberately narrow: an empty colour becomes the default
// rather than failing, because that is what an older client or a hand-written
// PUT would send. A *wrong* colour still fails — quietly substituting a value
// the caller did not ask for is the behaviour the preferences handler
// explicitly rejected.
func ValidateBoard(cards []Sticky) ([]Sticky, error) {
	if len(cards) > MaxStickies {
		return nil, wrapSticky("too many stickies (max %d)", MaxStickies)
	}
	seen := make(map[string]bool, len(cards))
	out := make([]Sticky, 0, len(cards))
	for _, c := range cards {
		if c.ID == "" {
			return nil, wrapSticky("sticky is missing an id")
		}
		if len(c.ID) > MaxStickyID {
			return nil, wrapSticky("sticky id too long (max %d bytes)", MaxStickyID)
		}
		if seen[c.ID] {
			return nil, wrapSticky("duplicate sticky id")
		}
		seen[c.ID] = true
		if len(c.Body) > MaxStickyBody {
			return nil, wrapSticky("sticky too large (max %d bytes)", MaxStickyBody)
		}
		if c.Color == "" {
			c.Color = "yellow"
		}
		if !StickyColors[c.Color] {
			return nil, wrapSticky("invalid colour")
		}
		out = append(out, c)
	}

	// Marshal-size check last: the per-card caps bound this already, but the
	// stored form is what has to fit, and that is the only honest way to
	// measure it.
	data, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	if len(data) > MaxStickyBoard {
		return nil, wrapSticky("board too large (max %d bytes)", MaxStickyBoard)
	}
	return out, nil
}

// wrapSticky builds a validation error whose message is what the user sees.
// It keeps ErrStickyBoard in the chain so the handler can classify with
// errors.Is (400 vs 500) without matching on strings.
func wrapSticky(format string, args ...any) error {
	return boardError{msg: fmt.Sprintf(format, args...)}
}

type boardError struct{ msg string }

func (e boardError) Error() string { return e.msg }
func (e boardError) Unwrap() error { return ErrStickyBoard }

// StickyStore persists one board per user. Two implementations, the same split
// TokenStore and PreferenceStore use: Postgres in multi mode (shared across
// replicas, no ReadWriteMany secrets volume) and a JSON file in the secrets
// directory in single mode (no database dependency for a single-box install).
type StickyStore interface {
	Get(userID int) ([]Sticky, error)
	Set(userID int, cards []Sticky) error
}

// --- Postgres ---------------------------------------------------------------

// PostgresStickyStore stores the whole board as one JSON document per user in
// the user_stickies table.
type PostgresStickyStore struct {
	db *DB
}

// NewPostgresStickyStore creates a Postgres-backed sticky store.
func NewPostgresStickyStore(db *DB) *PostgresStickyStore {
	return &PostgresStickyStore{db: db}
}

func (s *PostgresStickyStore) Get(userID int) ([]Sticky, error) {
	var data string
	err := s.db.QueryRow(
		`SELECT data FROM user_stickies WHERE user_id = $1`, userID).Scan(&data)
	if err != nil {
		// No row is an empty board, not an error: the first GET happens
		// before anything has ever been saved.
		if errors.Is(err, sql.ErrNoRows) {
			return []Sticky{}, nil
		}
		return nil, err
	}
	return decodeBoard([]byte(data))
}

func (s *PostgresStickyStore) Set(userID int, cards []Sticky) error {
	data, err := json.Marshal(cards)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO user_stickies (user_id, data, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (user_id) DO UPDATE
		  SET data = EXCLUDED.data, updated_at = NOW()`,
		userID, string(data))
	return err
}

// --- File (single mode) ------------------------------------------------------

// FileStickyStore stores boards in stickies.json under the secrets directory.
//
// The secrets directory — not NOTES_DIR/.sticky, which is where this feature
// was first sketched. Two reasons, and the second one is the load-bearing
// half. /data/notes is not itself a volume: setup.sh bind-mounts each MOUNT_
// namespace individually, so anything the backend creates under NOTES_DIR at
// runtime lands in the container's writable layer and is destroyed by
// `mdnest-server rebuild`. The secrets dir is a declared named volume that
// already holds auth.json, tokens.json and preferences.json, so a board
// survives a rebuild — and it is equally invisible to git-sync, which walks
// /data/notes/*/ only. Privacy without losing the data was the point.
type FileStickyStore struct {
	dir   string
	mu    sync.RWMutex
	users map[string][]Sticky
}

// NewFileStickyStore creates a file-backed sticky store rooted at dir.
func NewFileStickyStore(dir string) *FileStickyStore {
	s := &FileStickyStore{dir: dir, users: map[string][]Sticky{}}
	s.load()
	return s
}

func (s *FileStickyStore) path() string {
	return filepath.Join(s.dir, "stickies.json")
}

// load reads stickies.json into memory. A missing file is a first run. A
// corrupt one is logged and skipped rather than fatal — matching the
// preference store, because no personal scratch board is worth refusing to
// start the server over.
func (s *FileStickyStore) load() {
	data, err := os.ReadFile(s.path())
	if err != nil {
		return
	}
	var wrap struct {
		Users map[string][]Sticky `json:"users"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		log.Printf("warning: failed to parse stickies.json, starting fresh")
		return
	}
	if wrap.Users != nil {
		s.users = wrap.Users
	}
}

// save writes the in-memory store to disk. Caller holds the write lock.
//
// Write-to-temp-then-rename, unlike the preference store's plain WriteFile: a
// board is the user's own content rather than a setting they can re-pick in
// one click, and a truncated file from a crash mid-write would lose all of it.
// Rename within the same directory is atomic on every filesystem mdnest runs
// on, so a reader sees either the old board or the new one.
func (s *FileStickyStore) save() error {
	wrap := struct {
		Users map[string][]Sticky `json:"users"`
	}{Users: s.users}
	data, err := json.MarshalIndent(wrap, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "stickies-*.json.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op once the rename succeeds
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path())
}

func (s *FileStickyStore) Get(userID int) ([]Sticky, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	stored := s.users[strconv.Itoa(userID)]
	out := make([]Sticky, len(stored))
	copy(out, stored)
	return out, nil
}

func (s *FileStickyStore) Set(userID int, cards []Sticky) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cards == nil {
		cards = []Sticky{}
	}
	s.users[strconv.Itoa(userID)] = cards
	return s.save()
}

// decodeBoard turns stored JSON back into cards. A stored board that no longer
// parses returns an empty board rather than an error, for the same reason the
// file store tolerates a corrupt file.
func decodeBoard(data []byte) ([]Sticky, error) {
	if len(data) == 0 {
		return []Sticky{}, nil
	}
	var cards []Sticky
	if err := json.Unmarshal(data, &cards); err != nil {
		log.Printf("warning: failed to parse stored sticky board, returning empty")
		return []Sticky{}, nil
	}
	if cards == nil {
		cards = []Sticky{}
	}
	return cards, nil
}

// compile-time checks
var (
	_ StickyStore = (*PostgresStickyStore)(nil)
	_ StickyStore = (*FileStickyStore)(nil)
)
