package store

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// Preferences are small, per-user, non-sensitive UI settings — the kind of
// thing that would otherwise end up in localStorage and follow the browser
// instead of the person. They are deliberately server-side so a user gets the
// same mdnest on their laptop, their phone and a fresh private window.
//
// Values are opaque strings. The backend does not interpret them beyond a
// length cap and a key allowlist; the frontend owns their meaning. That keeps
// this from becoming a second config system.
type Preferences map[string]string

// PreferenceKeys is the complete set of keys the server will store. An
// allowlist rather than a free-form bag: this endpoint is writable by any
// authenticated user, so without it the table is an unbounded per-user blob
// store that anyone can fill.
var PreferenceKeys = map[string]bool{
	"theme": true,
}

// MaxPreferenceValue caps a single value. Themes are short words; the cap
// exists so a malformed or hostile client cannot write megabytes per user.
const MaxPreferenceValue = 64

// ValidPreference reports whether a key is storable and its value within
// bounds. Callers reject rather than truncate — silently storing something
// other than what was sent is worse than a 400.
func ValidPreference(key, value string) bool {
	return PreferenceKeys[key] && len(value) <= MaxPreferenceValue
}

// PreferenceStore persists per-user preferences. Two implementations, the same
// split the token store uses: Postgres in multi mode, a JSON file beside the
// other secrets-dir state in single mode. Single mode has exactly one user, so
// the file backend ignores the user id.
type PreferenceStore interface {
	Get(userID int) (Preferences, error)
	Set(userID int, prefs Preferences) error
}

// --- Postgres ---------------------------------------------------------------

// PostgresPreferenceStore stores preferences in the user_preferences table.
type PostgresPreferenceStore struct {
	db *DB
}

// NewPostgresPreferenceStore creates a Postgres-backed preference store.
func NewPostgresPreferenceStore(db *DB) *PostgresPreferenceStore {
	return &PostgresPreferenceStore{db: db}
}

func (s *PostgresPreferenceStore) Get(userID int) (Preferences, error) {
	rows, err := s.db.Query(
		`SELECT key, value FROM user_preferences WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	prefs := Preferences{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		prefs[k] = v
	}
	return prefs, rows.Err()
}

func (s *PostgresPreferenceStore) Set(userID int, prefs Preferences) error {
	for k, v := range prefs {
		_, err := s.db.Exec(`
			INSERT INTO user_preferences (user_id, key, value, updated_at)
			VALUES ($1, $2, $3, NOW())
			ON CONFLICT (user_id, key) DO UPDATE
			  SET value = EXCLUDED.value, updated_at = NOW()`,
			userID, k, v)
		if err != nil {
			return err
		}
	}
	return nil
}

// --- File (single mode) ------------------------------------------------------

// FilePreferenceStore stores preferences in preferences.json under the secrets
// directory — the same volume that already holds auth.json and tokens.json, so
// it survives `mdnest-server rebuild` like the rest of that state.
//
// Single mode has one identity, but the file is still keyed by user id: the
// auth middleware resolves single-mode requests to UserID=0, and keying it
// means the format does not have to change if that ever stops being true.
type FilePreferenceStore struct {
	dir   string
	mu    sync.RWMutex
	users map[string]Preferences
}

// NewFilePreferenceStore creates a file-backed preference store rooted at dir.
func NewFilePreferenceStore(dir string) *FilePreferenceStore {
	s := &FilePreferenceStore{dir: dir, users: map[string]Preferences{}}
	s.load()
	return s
}

func (s *FilePreferenceStore) path() string {
	return filepath.Join(s.dir, "preferences.json")
}

// load reads preferences.json into memory. A missing or corrupt file yields an
// empty store: a preference is a convenience, and losing one must never stop
// the server from starting.
func (s *FilePreferenceStore) load() {
	data, err := os.ReadFile(s.path())
	if err != nil {
		return
	}
	var wrap struct {
		Users map[string]Preferences `json:"users"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		log.Printf("warning: failed to parse preferences.json, starting fresh")
		return
	}
	if wrap.Users != nil {
		s.users = wrap.Users
	}
}

// save writes the in-memory store to disk. Caller holds the write lock.
func (s *FilePreferenceStore) save() error {
	wrap := struct {
		Users map[string]Preferences `json:"users"`
	}{Users: s.users}
	data, err := json.MarshalIndent(wrap, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	return os.WriteFile(s.path(), data, 0600)
}

func (s *FilePreferenceStore) Get(userID int) (Preferences, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := Preferences{}
	for k, v := range s.users[strconv.Itoa(userID)] {
		out[k] = v
	}
	return out, nil
}

func (s *FilePreferenceStore) Set(userID int, prefs Preferences) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := strconv.Itoa(userID)
	if s.users[id] == nil {
		s.users[id] = Preferences{}
	}
	for k, v := range prefs {
		s.users[id][k] = v
	}
	return s.save()
}

// compile-time checks
var (
	_ PreferenceStore = (*PostgresPreferenceStore)(nil)
	_ PreferenceStore = (*FilePreferenceStore)(nil)
)
