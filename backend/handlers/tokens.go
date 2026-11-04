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
	// groups and groupsMaxAge give an API token the IdP groups of its owner's
	// last SSO login while that snapshot is younger than groupsMaxAge.
	groups       store.OIDCGroupStore
	groupsMaxAge time.Duration
}

// NewTokenHandler wires a token handler to a token store.
func NewTokenHandler(s store.TokenStore) *TokenHandler {
	return &TokenHandler{store: s}
}

// UseOwnerGroups lets API tokens act with their owner's OIDC groups, as captured
// at the owner's last SSO login, for maxAge after that login. maxAge <= 0 keeps
// tokens on direct grants only.
func (h *TokenHandler) UseOwnerGroups(groups store.OIDCGroupStore, maxAge time.Duration) {
	h.groups, h.groupsMaxAge = groups, maxAge
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
	uc := &middleware.UserContext{ID: t.UserID, Username: t.Username, Role: t.UserRole}
	if h.groups != nil && h.groupsMaxAge > 0 {
		groups, err := h.groups.OIDCGroups(t.UserID, h.groupsMaxAge)
		if err != nil {
			log.Printf("api token: reading the OIDC groups of user %d: %v", t.UserID, err)
		}
		uc.Groups = groups
	}
	return uc
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

	// Return tokens without the actual token value or hash. Everyone, superadmins
	// included, sees only their own tokens here (Settings): another person's
	// token in your own list looks like yours. Superadmins audit every token
	// through /api/admin/tokens (Admin panel, with the owner shown).
	safe := make([]map[string]string, 0, len(tokens))
	for _, t := range tokens {
		if uc != nil && t.UserID != uc.ID {
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
	h.revoke(w, r, false)
}

// HandleAdminTokens serves /api/admin/tokens (superadmin only, gated by the
// route): GET lists every token with its owner, DELETE ?id= revokes any token.
func (h *TokenHandler) HandleAdminTokens(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		tokens, err := h.store.All()
		if err != nil {
			http.Error(w, `{"error":"failed to read tokens"}`, http.StatusInternalServerError)
			return
		}
		out := make([]map[string]any, 0, len(tokens))
		for _, t := range tokens {
			out = append(out, map[string]any{
				"id":           t.ID,
				"name":         t.Name,
				"token_suffix": t.TokenSuffix,
				"created_at":   t.CreatedAt,
				"user_id":      t.UserID,
				"username":     t.Username,
			})
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(out)
	case http.MethodDelete:
		h.revoke(w, r, true)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// revoke deletes a token: the caller's own one, or any token when anyOwner
// (the superadmin admin endpoint).
func (h *TokenHandler) revoke(w http.ResponseWriter, r *http.Request, anyOwner bool) {
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
	if uc != nil && !anyOwner && target.UserID != uc.ID {
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
	if uc != nil {
		log.Printf("API token revoked: %s (%s), owner %q (user %d), by %q (user %d)",
			target.Name, target.ID, target.Username, target.UserID, uc.Username, uc.ID)
	} else {
		log.Printf("API token revoked: %s (%s)", target.Name, target.ID)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
}
