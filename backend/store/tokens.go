package store

import (
	"database/sql"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// APIToken is a long-lived API/MCP access token. Only the sha256 hash of the
// raw token is ever persisted; the raw value is shown once at creation.
//
// The JSON tags match the on-disk tokens.json format so the file backend stays
// byte-compatible with existing single-mode installs and the host-side
// `mdnest-server create-token` CLI.
type APIToken struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Token       string `json:"token,omitempty"`     // only set transiently on creation; never persisted
	TokenHash   string `json:"token_hash"`          // stored; the lookup key
	TokenSuffix string `json:"token_suffix"`        // last 4 chars for identification
	CreatedAt   string `json:"created_at"`          // RFC3339
	UserID      int    `json:"user_id,omitempty"`   // owner; 0 for single-mode / legacy tokens
	Username    string `json:"username,omitempty"`  // resolved for multi-mode tokens
	UserRole    string `json:"user_role,omitempty"` // resolved for multi-mode tokens
}

// TokenStore persists API tokens. Two backends are selected at startup:
//   - FileTokenStore (single mode): the tokens.json file, unchanged behaviour,
//     so a single-box install keeps no database dependency.
//   - PostgresTokenStore (multi mode): the api_tokens table, so a multi-replica
//     deployment shares tokens through Postgres instead of a ReadWriteMany
//     secrets volume.
type TokenStore interface {
	// Add persists a new token entry.
	Add(t APIToken) error
	// All returns every token; callers apply their own visibility rules.
	All() ([]APIToken, error)
	// FindByHash returns the token whose hash matches, or (nil, nil) if none.
	FindByHash(hash string) (*APIToken, error)
	// DeleteByID removes a token; the bool reports whether a row was removed.
	DeleteByID(id string) (bool, error)
}

// --- Postgres backend (multi mode) ---

// PostgresTokenStore stores API tokens in the api_tokens table. Username and
// role are resolved by joining users at read time, so they never go stale.
type PostgresTokenStore struct {
	db *DB
}

// NewPostgresTokenStore creates a Postgres-backed token store.
func NewPostgresTokenStore(db *DB) *PostgresTokenStore {
	return &PostgresTokenStore{db: db}
}

const tokenSelect = `
	SELECT t.id, t.name, t.token_hash, t.token_suffix, t.created_at,
	       COALESCE(t.user_id, 0), COALESCE(u.username, ''), COALESCE(u.role, '')
	FROM api_tokens t
	LEFT JOIN users u ON u.id = t.user_id`

func (s *PostgresTokenStore) Add(t APIToken) error {
	var userID any
	if t.UserID > 0 {
		userID = t.UserID
	}
	_, err := s.db.Exec(
		`INSERT INTO api_tokens (id, name, token_hash, token_suffix, user_id)
		 VALUES ($1, $2, $3, $4, $5)`,
		t.ID, t.Name, t.TokenHash, t.TokenSuffix, userID,
	)
	return err
}

func (s *PostgresTokenStore) All() ([]APIToken, error) {
	rows, err := s.db.Query(tokenSelect + ` ORDER BY t.created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]APIToken, 0)
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *PostgresTokenStore) FindByHash(hash string) (*APIToken, error) {
	t, err := scanToken(s.db.QueryRow(tokenSelect+` WHERE t.token_hash = $1`, hash))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *PostgresTokenStore) DeleteByID(id string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM api_tokens WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// ImportFileTokens copies any tokens from a legacy tokens.json in dir into the
// api_tokens table, skipping ones already present (matched by hash). It lets an
// existing multi-mode install keep its API tokens across the move to Postgres,
// so an upgrade doesn't silently invalidate live tokens. A missing file is not
// an error. Returns the number of tokens newly imported. Idempotent.
func ImportFileTokens(db *DB, dir string) (int, error) {
	all, _ := NewFileTokenStore(dir).All()
	imported := 0
	for _, t := range all {
		var userID any
		if t.UserID > 0 {
			userID = t.UserID
		}
		res, err := db.Exec(
			`INSERT INTO api_tokens (id, name, token_hash, token_suffix, user_id)
			 VALUES ($1, $2, $3, $4, $5) ON CONFLICT (token_hash) DO NOTHING`,
			t.ID, t.Name, t.TokenHash, t.TokenSuffix, userID,
		)
		if err != nil {
			return imported, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			imported++
		}
	}
	return imported, nil
}

// rowScanner is satisfied by both *sql.Row and *sql.Rows.
type rowScanner interface{ Scan(dest ...any) error }

func scanToken(sc rowScanner) (APIToken, error) {
	var t APIToken
	var created time.Time
	if err := sc.Scan(&t.ID, &t.Name, &t.TokenHash, &t.TokenSuffix, &created, &t.UserID, &t.Username, &t.UserRole); err != nil {
		return APIToken{}, err
	}
	t.CreatedAt = created.UTC().Format(time.RFC3339)
	return t, nil
}

// --- File backend (single mode) ---

// FileTokenStore stores API tokens in tokens.json under a secrets directory.
// It preserves the previous behaviour, including the cache-miss reload that
// picks up tokens minted by the one-shot `mdnest-server create-token` CLI.
type FileTokenStore struct {
	dir    string
	mu     sync.RWMutex
	tokens []APIToken
}

// NewFileTokenStore creates a file-backed token store rooted at dir.
func NewFileTokenStore(dir string) *FileTokenStore {
	s := &FileTokenStore{dir: dir}
	s.load()
	return s
}

func (s *FileTokenStore) path() string { return filepath.Join(s.dir, "tokens.json") }

// load reads tokens.json into memory. Caller holds the write lock (or is the
// constructor). A missing or corrupt file yields an empty store.
func (s *FileTokenStore) load() {
	data, err := os.ReadFile(s.path())
	if err != nil {
		s.tokens = []APIToken{}
		return
	}
	var wrap struct {
		Tokens []APIToken `json:"tokens"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		log.Printf("warning: failed to parse tokens.json, starting fresh")
		s.tokens = []APIToken{}
		return
	}
	s.tokens = wrap.Tokens
}

// save writes the in-memory store to disk. Caller holds the write lock.
func (s *FileTokenStore) save() error {
	wrap := struct {
		Tokens []APIToken `json:"tokens"`
	}{Tokens: s.tokens}
	data, err := json.MarshalIndent(wrap, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path(), data, 0600)
}

func (s *FileTokenStore) Add(t APIToken) error {
	t.Token = "" // never persist the raw token
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tokens = append(s.tokens, t)
	return s.save()
}

func (s *FileTokenStore) All() ([]APIToken, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]APIToken, len(s.tokens))
	copy(out, s.tokens)
	return out, nil
}

func (s *FileTokenStore) FindByHash(hash string) (*APIToken, error) {
	s.mu.RLock()
	if t := findByHash(s.tokens, hash); t != nil {
		s.mu.RUnlock()
		return t, nil
	}
	s.mu.RUnlock()

	// Cache miss: reload from disk to catch CLI-minted tokens, then re-check.
	s.mu.Lock()
	s.load()
	t := findByHash(s.tokens, hash)
	s.mu.Unlock()
	return t, nil
}

func findByHash(tokens []APIToken, hash string) *APIToken {
	for i := range tokens {
		if tokens[i].TokenHash == hash {
			cp := tokens[i]
			return &cp
		}
	}
	return nil
}

func (s *FileTokenStore) DeleteByID(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	filtered := make([]APIToken, 0, len(s.tokens))
	found := false
	for _, t := range s.tokens {
		if t.ID == id {
			found = true
			continue
		}
		filtered = append(filtered, t)
	}
	if !found {
		return false, nil
	}
	s.tokens = filtered
	return true, s.save()
}
