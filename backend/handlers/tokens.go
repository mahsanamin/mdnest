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
)

// APIToken represents a long-lived API token for MCP/API access.
type APIToken struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Token     string `json:"token,omitempty"` // only included on creation
	TokenHash string `json:"token_hash"`      // stored, not exposed after creation
	CreatedAt string `json:"created_at"`
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

// ValidateAPIToken checks if a raw token matches any stored token.
// Returns true if valid.
func (h *TokenHandler) ValidateAPIToken(rawToken string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, t := range h.store.Tokens {
		if t.TokenHash == hashToken(rawToken) {
			return true
		}
	}
	return false
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

	// Return tokens without the actual token value or hash
	safe := make([]map[string]string, 0, len(h.store.Tokens))
	for _, t := range h.store.Tokens {
		safe = append(safe, map[string]string{
			"id":         t.ID,
			"name":       t.Name,
			"created_at": t.CreatedAt,
		})
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(safe)
}

func (h *TokenHandler) createToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Name == "" {
		http.Error(w, `{"error":"name is required"}`, http.StatusBadRequest)
		return
	}

	token, err := generateToken()
	if err != nil {
		http.Error(w, `{"error":"failed to generate token"}`, http.StatusInternalServerError)
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	entry := APIToken{
		ID:        generateID(),
		Name:      req.Name,
		TokenHash: hashToken(token),
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	h.store.Tokens = append(h.store.Tokens, entry)

	if err := h.save(); err != nil {
		http.Error(w, `{"error":"failed to save token"}`, http.StatusInternalServerError)
		return
	}

	log.Printf("API token created: %s (%s)", req.Name, entry.ID)

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

	found := false
	filtered := make([]APIToken, 0, len(h.store.Tokens))
	for _, t := range h.store.Tokens {
		if t.ID == id {
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
