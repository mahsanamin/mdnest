package middleware

import (
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
)

// TokenValidator validates API tokens (implemented by TokenHandler).
type TokenValidator interface {
	ValidateAPIToken(token string) bool
}

// AuthMiddleware validates JWT tokens or API tokens on protected routes.
type AuthMiddleware struct {
	secret         []byte
	tokenValidator TokenValidator
}

// NewAuthMiddleware creates a new auth middleware.
func NewAuthMiddleware(secret string, tv TokenValidator) *AuthMiddleware {
	return &AuthMiddleware{secret: []byte(secret), tokenValidator: tv}
}

// Wrap wraps an http.Handler with authentication.
// Accepts either:
//   - Bearer <JWT> (from browser login)
//   - Bearer mdnest_<token> (API token for MCP/API)
func (a *AuthMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" {
			http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
			http.Error(w, `{"error":"invalid authorization header"}`, http.StatusUnauthorized)
			return
		}

		tokenString := parts[1]

		// Check if it's an API token (starts with mdnest_)
		if strings.HasPrefix(tokenString, "mdnest_") {
			if a.tokenValidator != nil && a.tokenValidator.ValidateAPIToken(tokenString) {
				next.ServeHTTP(w, r)
				return
			}
			http.Error(w, `{"error":"invalid API token"}`, http.StatusUnauthorized)
			return
		}

		// Otherwise validate as JWT
		token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, jwt.ErrSignatureInvalid
			}
			return a.secret, nil
		})
		if err != nil || !token.Valid {
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		next.ServeHTTP(w, r)
	})
}
