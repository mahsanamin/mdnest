package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
)

// APIToken represents a long-lived API token for MCP/API access.
type APIToken struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Token       string `json:"token,omitempty"`  // only included on creation
	TokenHash   string `json:"token_hash"`       // stored, not exposed after creation
	TokenSuffix string `json:"token_suffix"`     // last 4 chars for identification
	CreatedAt   string `json:"created_at"`
	UserID    int    `json:"user_id,omitempty"`   // owner (multi mode only, 0 = legacy/single)
	Username  string `json:"username,omitempty"`  // denormalized for resolution
	UserRole  string `json:"user_role,omitempty"` // denormalized for resolution
}

// tokenStore holds all API tokens.
type tokenStore struct {
	Tokens []APIToken `json:"tokens"`
}

type TokenHandler struct {
	secretsDir string
	mu         sync.RWMutex
	store      tokenStore
}

func NewTokenHandler(secretsDir string) *TokenHandler {
	h := &TokenHandler{secretsDir: secretsDir}
	h.load()
	return h
}

func (h *TokenHandler) filePath() string {
	return filepath.Join(h.secretsDir, "tokens.json")
}

func (h *TokenHandler) load() {
	data, err := os.ReadFile(h.filePath())
	if err != nil {
		h.store = tokenStore{Tokens: []APIToken{}}
		return
	}
	if err := json.Unmarshal(data, &h.store); err != nil {
		log.Printf("warning: failed to parse tokens.json, starting fresh")
		h.store = tokenStore{Tokens: []APIToken{}}
	}
}

func (h *TokenHandler) save() error {
	data, err := json.MarshalIndent(h.store, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(h.filePath(), data, 0600)
}

func generateToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "mdnest_" + hex.EncodeToString(b), nil
}

func generateID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// hashMatchesAny scans the in-memory store for a hash match. Caller is
// responsible for holding h.mu (read lock is enough).
func (h *TokenHandler) hashMatchesAny(hash string) bool {
	for _, t := range h.store.Tokens {
		if t.TokenHash == hash {
			return true
		}
	}
	return false
}

// ValidateAPIToken checks if a raw token matches any stored token.
// Returns true if valid.
//
// Cache-miss reload: if the token isn't found in the in-memory store,
// we reload tokens.json from disk and check again. This catches tokens
// minted by the host-side `mdnest-server create-token` CLI, which runs
// in a one-shot container that writes the file but can't update the
// running server's in-memory state. Successful validations stay fast
// (one read-lock + map walk); only misses pay the file-read cost.
func (h *TokenHandler) ValidateAPIToken(rawToken string) bool {
	hash := hashToken(rawToken)
	h.mu.RLock()
	if h.hashMatchesAny(hash) {
		h.mu.RUnlock()
		return true
	}
	h.mu.RUnlock()

	h.mu.Lock()
	// Re-check after grabbing the write lock in case another goroutine
	// reloaded between our read and write.
	if h.hashMatchesAny(hash) {
		h.mu.Unlock()
		return true
	}
	h.load()
	matched := h.hashMatchesAny(hash)
	h.mu.Unlock()
	return matched
}

// ResolveAPITokenUser returns the UserContext for an API token (multi mode).
// Returns nil if the token has no associated user (single mode / legacy tokens).
func (h *TokenHandler) ResolveAPITokenUser(rawToken string) *middleware.UserContext {
	hash := hashToken(rawToken)
	h.mu.RLock()
	for _, t := range h.store.Tokens {
		if t.TokenHash == hash && t.UserID > 0 {
			uc := &middleware.UserContext{ID: t.UserID, Username: t.Username, Role: t.UserRole}
			h.mu.RUnlock()
			return uc
		}
	}
	h.mu.RUnlock()
	// ValidateAPIToken's cache-miss reload usually warmed our in-memory
	// store already, but be defensive in case a CLI-minted multi-mode
	// token (with a user binding) lands between Validate and Resolve.
	h.mu.Lock()
	h.load()
	for _, t := range h.store.Tokens {
		if t.TokenHash == hash && t.UserID > 0 {
			uc := &middleware.UserContext{ID: t.UserID, Username: t.Username, Role: t.UserRole}
			h.mu.Unlock()
			return uc
		}
	}
	h.mu.Unlock()
	return nil
}

func hashToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// HandleTokens dispatches token CRUD: GET (list), POST (create), DELETE (revoke).
func (h *TokenHandler) HandleTokens(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listTokens(w, r)
	case http.MethodPost:
		h.createToken(w, r)
	case http.MethodDelete:
		h.revokeToken(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func (h *TokenHandler) listTokens(w http.ResponseWriter, r *http.Request) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	uc := middleware.UserFromContext(r.Context())

	// Return tokens without the actual token value or hash. Scope:
	// superadmins see all; everyone else (admin, collaborator) sees own.
	// (As of v3.5.0 the namespace-scoped admin role no longer gets
	// system-wide visibility into other users' tokens — that's a
	// superadmin-only audit capability.)
	safe := make([]map[string]string, 0, len(h.store.Tokens))
	for _, t := range h.store.Tokens {
		if uc != nil && uc.Role != "superadmin" && t.UserID != uc.ID {
			continue
		}
		safe = append(safe, map[string]string{
			"id":           t.ID,
			"name":         t.Name,
			"token_suffix": t.TokenSuffix,
			"created_at":   t.CreatedAt,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(safe)
}

// CreateAPIToken creates a new API token, persists it, and returns the raw
// token string and the stored entry. The raw token is the only place
// the caller can ever read this value — it isn't kept anywhere; only
// its sha256 hash is stored. Used by both the HTTP handler and the
// host-side `mdnest-server create-token` CLI.
func (h *TokenHandler) CreateAPIToken(name string, userID int, username, role string) (string, *APIToken, error) {
	token, err := generateToken()
	if err != nil {
		return "", nil, err
	}

	suffix := token
	if len(suffix) > 4 {
		suffix = suffix[len(suffix)-4:]
	}

	entry := APIToken{
		ID:          generateID(),
		Name:        name,
		TokenHash:   hashToken(token),
		TokenSuffix: suffix,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		UserID:      userID,
		Username:    username,
		UserRole:    role,
	}

	h.mu.Lock()
	h.store.Tokens = append(h.store.Tokens, entry)
	saveErr := h.save()
	h.mu.Unlock()

	if saveErr != nil {
		return "", nil, saveErr
	}
	log.Printf("API token created: %s (%s)", entry.Name, entry.ID)
	return token, &entry, nil
}

func (h *TokenHandler) createToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}

	userID := 0
	username := ""
	role := ""
	if uc := middleware.UserFromContext(r.Context()); uc != nil {
		userID = uc.ID
		username = uc.Username
		role = uc.Role
	}

	token, entry, err := h.CreateAPIToken(req.Name, userID, username, role)
	if err != nil {
		http.Error(w, `{"error":"failed to create token"}`, http.StatusInternalServerError)
		return
	}

	// Return the token value — this is the only time it's shown
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"id":         entry.ID,
		"name":       entry.Name,
		"token":      token,
		"created_at": entry.CreatedAt,
	})
}

func (h *TokenHandler) revokeToken(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, `{"error":"id is required"}`, http.StatusBadRequest)
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	uc := middleware.UserFromContext(r.Context())

	found := false
	filtered := make([]APIToken, 0, len(h.store.Tokens))
	for _, t := range h.store.Tokens {
		if t.ID == id {
			// Scope: superadmin can revoke any token; anyone else can
			// only revoke tokens they own.
			if uc != nil && uc.Role != "superadmin" && t.UserID != uc.ID {
				http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
				return
			}
			found = true
			log.Printf("API token revoked: %s (%s)", t.Name, t.ID)
			continue
		}
		filtered = append(filtered, t)
	}

	if !found {
		http.Error(w, `{"error":"token not found"}`, http.StatusNotFound)
		return
	}

	h.store.Tokens = filtered
	if err := h.save(); err != nil {
		http.Error(w, `{"error":"failed to save"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
}
