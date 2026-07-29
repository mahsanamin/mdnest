package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

// TokenHandler serves API-token CRUD and validation, delegating persistence to
// a store.TokenStore (the tokens.json file in single mode, Postgres in multi
// mode).
type TokenHandler struct {
	store store.TokenStore
}

// NewTokenHandler wires a token handler to a token store.
func NewTokenHandler(s store.TokenStore) *TokenHandler {
	return &TokenHandler{store: s}
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

// ValidateAPIToken reports whether a raw token matches a stored token.
func (h *TokenHandler) ValidateAPIToken(rawToken string) bool {
	t, err := h.store.FindByHash(hashToken(rawToken))
	if err != nil {
		log.Printf("token validation error: %v", err)
		return false
	}
	return t != nil
}

// ResolveAPITokenUser returns the UserContext for an API token bound to a user
// (multi mode). Returns nil for single-mode / legacy tokens with no owner.
func (h *TokenHandler) ResolveAPITokenUser(rawToken string) *middleware.UserContext {
	t, err := h.store.FindByHash(hashToken(rawToken))
	if err != nil || t == nil || t.UserID == 0 {
		return nil
	}
	return &middleware.UserContext{ID: t.UserID, Username: t.Username, Role: t.UserRole}
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
	tokens, err := h.store.All()
	if err != nil {
		http.Error(w, `{"error":"failed to read tokens"}`, http.StatusInternalServerError)
		return
	}

	uc := middleware.UserFromContext(r.Context())

	// Return tokens without the actual token value or hash. Scope:
	// superadmins see all; everyone else (admin, collaborator) sees own.
	// (As of v3.5.0 the namespace-scoped admin role no longer gets
	// system-wide visibility into other users' tokens — that's a
	// superadmin-only audit capability.)
	safe := make([]map[string]string, 0, len(tokens))
	for _, t := range tokens {
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
func (h *TokenHandler) CreateAPIToken(name string, userID int, username, role string) (string, *store.APIToken, error) {
	token, err := generateToken()
	if err != nil {
		return "", nil, err
	}

	suffix := token
	if len(suffix) > 4 {
		suffix = suffix[len(suffix)-4:]
	}

	entry := store.APIToken{
		ID:          generateID(),
		Name:        name,
		TokenHash:   hashToken(token),
		TokenSuffix: suffix,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		UserID:      userID,
		Username:    username,
		UserRole:    role,
	}

	if err := h.store.Add(entry); err != nil {
		return "", nil, err
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

	tokens, err := h.store.All()
	if err != nil {
		http.Error(w, `{"error":"failed to read tokens"}`, http.StatusInternalServerError)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	var target *store.APIToken
	for i := range tokens {
		if tokens[i].ID == id {
			target = &tokens[i]
			break
		}
	}
	if target == nil {
		http.Error(w, `{"error":"token not found"}`, http.StatusNotFound)
		return
	}
	// Scope: superadmin can revoke any token; anyone else only their own.
	if uc != nil && uc.Role != "superadmin" && target.UserID != uc.ID {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	removed, err := h.store.DeleteByID(id)
	if err != nil {
		http.Error(w, `{"error":"failed to save"}`, http.StatusInternalServerError)
		return
	}
	if !removed {
		http.Error(w, `{"error":"token not found"}`, http.StatusNotFound)
		return
	}
	log.Printf("API token revoked: %s (%s)", target.Name, target.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
}
