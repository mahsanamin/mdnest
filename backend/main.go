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

	authHandler := handlers.NewAuthHandler(user, password, jwtSecret)
	nsHandler := handlers.NewNamespaceHandler(absNotesDir)
	noteHandler := handlers.NewNoteHandler(absNotesDir)
	treeHandler := handlers.NewTreeHandler(absNotesDir)
	uploadHandler := handlers.NewUploadHandler(absNotesDir)
	moveHandler := handlers.NewMoveHandler(absNotesDir)
	searchHandler := handlers.NewSearchHandler(absNotesDir)

	authMiddleware := middleware.NewAuthMiddleware(jwtSecret)
	corsMiddleware := middleware.NewCORSMiddleware(frontendOrigin)

	mux := http.NewServeMux()

	mux.HandleFunc("/api/auth/login", authHandler.Login)
	mux.Handle("/api/namespaces", authMiddleware.Wrap(http.HandlerFunc(nsHandler.ListNamespaces)))
	mux.Handle("/api/tree", authMiddleware.Wrap(http.HandlerFunc(treeHandler.GetTree)))
	mux.Handle("/api/note", authMiddleware.Wrap(http.HandlerFunc(noteHandler.Handle)))
	mux.Handle("/api/folder", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleFolder)))
	mux.Handle("/api/upload", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleUpload)))
	mux.Handle("/api/move", authMiddleware.Wrap(http.HandlerFunc(moveHandler.HandleMove)))
	mux.Handle("/api/search", authMiddleware.Wrap(http.HandlerFunc(searchHandler.HandleSearch)))
	mux.Handle("/api/files/", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleServeFile)))

	handler := corsMiddleware.Wrap(mux)

	log.Printf("mdnest backend listening on :%s (NOTES_DIR=%s)", port, absNotesDir)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal(err)
	}
}
