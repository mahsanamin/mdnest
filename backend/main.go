package main

import (
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	user := env("MDNEST_USER", "admin")
	password := env("MDNEST_PASSWORD", "changeme")
	jwtSecret := env("MDNEST_JWT_SECRET", "changeme")
	notesDir := env("NOTES_DIR", "./notes")
	frontendOrigin := env("FRONTEND_ORIGIN", "http://localhost:5173")
	port := env("PORT", "8080")

	absNotesDir, err := filepath.Abs(notesDir)
	if err != nil {
		log.Fatalf("failed to resolve NOTES_DIR: %v", err)
	}
	if err := os.MkdirAll(absNotesDir, 0755); err != nil {
		log.Fatalf("failed to create NOTES_DIR: %v", err)
	}

	secretsDir := env("SECRETS_DIR", filepath.Join(absNotesDir, ".secrets"))
	authHandler := handlers.NewAuthHandler(user, password, jwtSecret, secretsDir)
	nsHandler := handlers.NewNamespaceHandler(absNotesDir)
	noteHandler := handlers.NewNoteHandler(absNotesDir)
	treeHandler := handlers.NewTreeHandler(absNotesDir)
	uploadHandler := handlers.NewUploadHandler(absNotesDir)
	moveHandler := handlers.NewMoveHandler(absNotesDir)
	searchHandler := handlers.NewSearchHandler(absNotesDir)
	tokenHandler := handlers.NewTokenHandler(secretsDir)

	// Wrap mutating handlers to invalidate search cache
	invalidateSearch := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r)
			if ns := r.URL.Query().Get("ns"); ns != "" {
				searchHandler.InvalidateCache(ns)
			}
		})
	}

	authMiddleware := middleware.NewAuthMiddleware(jwtSecret, tokenHandler)
	corsMiddleware := middleware.NewCORSMiddleware(frontendOrigin)

	mux := http.NewServeMux()

	mux.HandleFunc("/api/auth/login", authHandler.Login)
	mux.Handle("/api/auth/change-password", authMiddleware.Wrap(http.HandlerFunc(authHandler.ChangePassword)))
	mux.Handle("/api/auth/tokens", authMiddleware.Wrap(http.HandlerFunc(tokenHandler.HandleTokens)))
	mux.Handle("/api/namespaces", authMiddleware.Wrap(http.HandlerFunc(nsHandler.ListNamespaces)))
	mux.Handle("/api/tree", authMiddleware.Wrap(http.HandlerFunc(treeHandler.GetTree)))
	mux.Handle("/api/note", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(noteHandler.Handle))))
	mux.Handle("/api/folder", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(uploadHandler.HandleFolder))))
	mux.Handle("/api/upload", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(uploadHandler.HandleUpload))))
	mux.Handle("/api/move", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(moveHandler.HandleMove))))
	mux.Handle("/api/search", authMiddleware.Wrap(http.HandlerFunc(searchHandler.HandleSearch)))
	mux.Handle("/api/files/", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleServeFile)))

	handler := corsMiddleware.Wrap(mux)

	log.Printf("mdnest backend listening on :%s (NOTES_DIR=%s)", port, absNotesDir)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal(err)
	}
}
