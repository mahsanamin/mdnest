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

// APITokenUserResolver resolves the user context for an API token.
// Returns nil if the token has no associated user (single-user mode).
type APITokenUserResolver interface {
	ResolveAPITokenUser(token string) *UserContext
}

// AuthMiddleware validates JWT tokens or API tokens on protected routes.
type AuthMiddleware struct {
	secret         []byte
	multiMode      bool
	tokenValidator TokenValidator
	tokenResolver  APITokenUserResolver
}

// NewAuthMiddleware creates a new auth middleware.
func NewAuthMiddleware(secret string, multiMode bool, tv TokenValidator, tr APITokenUserResolver) *AuthMiddleware {
	return &AuthMiddleware{
		secret:         []byte(secret),
		multiMode:      multiMode,
		tokenValidator: tv,
		tokenResolver:  tr,
	}
}

// Wrap wraps an http.Handler with authentication.
// Accepts either:
//   - Bearer <JWT> (from browser login)
//   - Bearer mdnest_<token> (API token for MCP/API)
//   - ?token=<JWT> query parameter (for <img>/<a>/etc. that can't set
//     custom request headers — used by the Live editor's pasted/uploaded
//     image rendering, which sets src="/api/files/<ns>/<path>?token=…")
func (a *AuthMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		var tokenString string

		if authHeader != "" {
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || !strings.EqualFold(parts[0], "bearer") {
				http.Error(w, `{"error":"invalid authorization header"}`, http.StatusUnauthorized)
				return
			}
			tokenString = parts[1]
		} else if qt := r.URL.Query().Get("token"); qt != "" {
			// Fallback for browser GETs that can't set Authorization
			// (image src, anchor downloads). Same validation flow as
			// Bearer below — both JWT and mdnest_ API tokens accepted.
			tokenString = qt
		} else {
			http.Error(w, `{"error":"missing authorization header"}`, http.StatusUnauthorized)
			return
		}

		// Check if it's an API token (starts with mdnest_)
		if strings.HasPrefix(tokenString, "mdnest_") {
			if a.tokenValidator != nil && a.tokenValidator.ValidateAPIToken(tokenString) {
				// In multi mode an API token acts as its owner. A token with no
				// owner (one minted in single mode and imported when the install
				// switched to multi mode) would reach the permission layer with
				// no user, which is single mode's "everything" — refuse it.
				if a.multiMode {
					var uc *UserContext
					if a.tokenResolver != nil {
						uc = a.tokenResolver.ResolveAPITokenUser(tokenString)
					}
					if uc == nil {
						http.Error(w, `{"error":"this API token has no owner; create a new one in Settings → API Tokens"}`, http.StatusUnauthorized)
						return
					}
					// Copy before marking: the resolver may hand out a shared value.
					tokenUser := *uc
					tokenUser.ViaAPIToken = true
					r = WithUser(r, &tokenUser)
				}
				r = withAPIToken(r)
				next.ServeHTTP(w, r)
				return
			}
			http.Error(w, `{"error":"invalid API token"}`, http.StatusUnauthorized)
			return
		}

		// Otherwise validate as a session JWT.
		claims, err := ParseSessionToken(a.secret, tokenString)
		if err != nil {
			http.Error(w, `{"error":"invalid or expired token"}`, http.StatusUnauthorized)
			return
		}

		// In multi mode, extract user context from JWT claims
		if a.multiMode {
			r = WithUser(r, UserFromClaims(claims))
		}

		next.ServeHTTP(w, r)
	})
}

// ParseSessionToken validates a session JWT: signed with secret by HMAC, not
// expired, and carrying no "purpose" claim. A purpose marks a login step token
// (TOTP code, forced TOTP setup, forced password change). Those are signed
// with the same secret, so without this rule the token a user holds after the
// password and BEFORE the second factor worked as a full session everywhere.
// A step token is good only at the one endpoint that consumes its step, which
// parses it itself. Every JWT this server mints as a session — password and
// TOTP logins, SSO, Firebase, dev login — has no purpose claim.
func ParseSessionToken(secret []byte, tokenString string) (jwt.MapClaims, error) {
	token, err := jwt.Parse(tokenString, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return secret, nil
	})
	if err != nil || !token.Valid {
		return nil, jwt.ErrTokenInvalidClaims
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, jwt.ErrTokenInvalidClaims
	}
	if _, isStep := claims["purpose"]; isStep {
		return nil, jwt.ErrTokenInvalidClaims
	}
	return claims, nil
}

// UserFromClaims builds the request's user from session claims (multi mode).
func UserFromClaims(claims jwt.MapClaims) *UserContext {
	uc := &UserContext{}
	if v, ok := claims["user_id"].(float64); ok {
		uc.ID = int(v)
	}
	if v, ok := claims["sub"].(string); ok {
		uc.Username = v
	}
	if v, ok := claims["role"].(string); ok {
		uc.Role = v
	}
	if raw, ok := claims["groups"].([]interface{}); ok {
		for _, g := range raw {
			if s, ok := g.(string); ok && s != "" {
				uc.Groups = append(uc.Groups, s)
			}
		}
	}
	return uc
}
