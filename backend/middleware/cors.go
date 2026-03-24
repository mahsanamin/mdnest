package middleware

import "net/http"

// CORSMiddleware handles CORS headers for the frontend origin.
type CORSMiddleware struct {
	origin string
}

// NewCORSMiddleware creates a new CORS middleware for the given origin.
func NewCORSMiddleware(origin string) *CORSMiddleware {
	return &CORSMiddleware{origin: origin}
}

// Wrap wraps an http.Handler with CORS headers.
func (c *CORSMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", c.origin)
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}
