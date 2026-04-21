package main

import (
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	// Support -migrate flag for running migrations only (then exit)
	migrateOnly := len(os.Args) > 1 && os.Args[1] == "-migrate"

	user := env("MDNEST_USER", "admin")
	password := env("MDNEST_PASSWORD", "changeme")
	jwtSecret := env("MDNEST_JWT_SECRET", "changeme")
	notesDir := env("NOTES_DIR", "./notes")
	frontendOrigin := env("FRONTEND_ORIGIN", "http://localhost:5173")
	port := env("PORT", "8080")
	authMode := env("AUTH_MODE", "single")

	if password == "changeme" || jwtSecret == "changeme" {
		log.Println("WARNING: using default credentials — change MDNEST_PASSWORD and MDNEST_JWT_SECRET in your .env")
	}

	absNotesDir, err := filepath.Abs(notesDir)
	if err != nil {
		log.Fatalf("failed to resolve NOTES_DIR: %v", err)
	}
	if err := os.MkdirAll(absNotesDir, 0755); err != nil {
		log.Fatalf("failed to create NOTES_DIR: %v", err)
	}

	// Database setup (multi mode only)
	var db *store.DB
	if authMode == "multi" {
		log.Println("AUTH_MODE=multi — connecting to PostgreSQL...")
		db, err = store.Connect()
		if err != nil {
			log.Fatalf("failed to connect to database: %v", err)
		}
		defer db.Close()

		if err := db.Migrate(); err != nil {
			log.Fatalf("database migration failed: %v", err)
		}
		log.Println("multi-user mode ready")

		if migrateOnly {
			log.Println("migrations complete — exiting (migrate-only mode)")
			return
		}
	} else {
		if migrateOnly {
			log.Fatal("ERROR: -migrate flag requires AUTH_MODE=multi")
		}
		log.Println("AUTH_MODE=single — file-based auth (no database)")
	}

	secretsDir := env("SECRETS_DIR", filepath.Join(absNotesDir, ".secrets"))
	multiMode := authMode == "multi"

	// 2FA requirement (optional, multi mode only)
	require2FA := multiMode && env("REQUIRE_2FA", "false") == "true"
	if require2FA {
		log.Println("2FA is REQUIRED for all users")
	}

	// Create auth handler based on mode
	var authHandler *handlers.AuthHandler
	var userStore store.UserStore

	if multiMode {
		userStore = store.NewPostgresUserStore(db)

		// Seed admin user on first startup
		count, err := userStore.CountUsers()
		if err != nil {
			log.Fatalf("failed to count users: %v", err)
		}
		if count == 0 {
			email := user + "@mdnest.local"
			_, err := userStore.CreateUser(email, user, password, "admin", nil)
			if err != nil {
				log.Fatalf("failed to seed admin user: %v", err)
			}
			log.Printf("seeded admin user: %s (%s)", user, email)
		}

		authHandler = handlers.NewMultiAuthHandler(jwtSecret, userStore, require2FA)
	} else {
		authHandler = handlers.NewAuthHandler(user, password, jwtSecret, secretsDir)
	}

	// Permission checker (nil in single mode, wraps grant checks in multi mode)
	var perms *middleware.PermissionChecker
	var grantStore store.GrantStore
	if multiMode {
		grantStore = store.NewPostgresGrantStore(db)
		perms = middleware.NewPermissionChecker(grantStore)
	}

	// Live collaboration hub (optional, multi mode only)
	enableCollab := multiMode && env("ENABLE_LIVE_COLLAB", "false") == "true"
	var collabHub *collab.Hub
	if enableCollab {
		collabHub = collab.NewHub()
		log.Println("live collaboration enabled (WebSocket)")
	}

	nsHandler := handlers.NewNamespaceHandler(absNotesDir, perms)
	noteHandler := handlers.NewNoteHandler(absNotesDir)
	if collabHub != nil {
		noteHandler.SetCollabHub(collabHub)
	}
	treeHandler := handlers.NewTreeHandler(absNotesDir, grantStore)
	uploadHandler := handlers.NewUploadHandler(absNotesDir)
	moveHandler := handlers.NewMoveHandler(absNotesDir)
	searchHandler := handlers.NewSearchHandler(absNotesDir)
	tokenHandler := handlers.NewTokenHandler(secretsDir)
	commentsHandler := handlers.NewCommentsHandler(absNotesDir)

	// Wrap mutating handlers to invalidate search cache + notify tree change
	// Only invalidate search cache and broadcast tree-changed on mutating requests.
	// GET requests must NOT trigger broadcasts — that causes an infinite loop
	// (broadcast → client refreshes tree → GET → broadcast → ...).
	invalidateSearch := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r)
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				return // Read-only — no cache invalidation or broadcast
			}
			if ns := r.URL.Query().Get("ns"); ns != "" {
				searchHandler.InvalidateCache(ns)
				if collabHub != nil {
					collabHub.BroadcastTreeChanged(ns)
				}
			}
		})
	}

	authMiddleware := middleware.NewAuthMiddleware(jwtSecret, multiMode, tokenHandler, tokenHandler)
	corsMiddleware := middleware.NewCORSMiddleware(frontendOrigin)

	mux := http.NewServeMux()

	serverAlias := env("SERVER_ALIAS", "")
	configHandler := handlers.NewConfigHandler(authMode, enableCollab, serverAlias, require2FA)
	mux.HandleFunc("/api/config", configHandler.HandleConfig)
	mux.HandleFunc("/api/auth/login", authHandler.Login)
	mux.Handle("/api/auth/change-password", authMiddleware.Wrap(http.HandlerFunc(authHandler.ChangePassword)))
	mux.HandleFunc("/api/auth/change-password-forced", authHandler.HandleForcedPasswordChange)
	mux.Handle("/api/auth/tokens", authMiddleware.Wrap(http.HandlerFunc(tokenHandler.HandleTokens)))

	// TOTP / 2FA routes (multi mode only)
	var totpHandler *handlers.TOTPHandler
	if multiMode {
		totpIssuer := env("TOTP_ISSUER", "mdnest")
		totpHandler = handlers.NewTOTPHandler(jwtSecret, userStore, totpIssuer)
		mux.Handle("/api/auth/totp/setup", authMiddleware.Wrap(http.HandlerFunc(totpHandler.HandleSetupTOTP)))
		mux.Handle("/api/auth/totp/verify-setup", authMiddleware.Wrap(http.HandlerFunc(totpHandler.HandleVerifySetup)))
		mux.Handle("/api/auth/totp/disable", authMiddleware.Wrap(http.HandlerFunc(totpHandler.HandleDisableTOTP)))
		mux.HandleFunc("/api/auth/verify-totp", totpHandler.HandleVerifyLoginTOTP) // no auth — uses temp token
		mux.HandleFunc("/api/auth/totp/setup-with-temp", totpHandler.HandleSetupTOTPWithTemp) // no auth — uses temp token for forced setup
	}

	// Apply permission checks in multi mode, passthrough in single mode
	if perms != nil {
		mux.Handle("/api/namespaces", authMiddleware.Wrap(http.HandlerFunc(nsHandler.ListNamespaces)))
		mux.Handle("/api/tree", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(treeHandler.GetTree))))
		mux.Handle("/api/note", authMiddleware.Wrap(perms.ReadWriteRouter(invalidateSearch(http.HandlerFunc(noteHandler.Handle)))))
		mux.Handle("/api/comments", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(commentsHandler.Handle))))
		mux.Handle("/api/folder", authMiddleware.Wrap(perms.RequireWrite(invalidateSearch(http.HandlerFunc(uploadHandler.HandleFolder)))))
		mux.Handle("/api/upload", authMiddleware.Wrap(perms.RequireWrite(invalidateSearch(http.HandlerFunc(uploadHandler.HandleUpload)))))
		mux.Handle("/api/move", authMiddleware.Wrap(perms.RequireMove(invalidateSearch(http.HandlerFunc(moveHandler.HandleMove)))))
		mux.Handle("/api/search", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(searchHandler.HandleSearch))))
		mux.Handle("/api/files/", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleServeFile))) // files endpoint extracts ns from URL, handled differently
	} else {
		mux.Handle("/api/namespaces", authMiddleware.Wrap(http.HandlerFunc(nsHandler.ListNamespaces)))
		mux.Handle("/api/tree", authMiddleware.Wrap(http.HandlerFunc(treeHandler.GetTree)))
		mux.Handle("/api/note", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(noteHandler.Handle))))
		mux.Handle("/api/comments", authMiddleware.Wrap(http.HandlerFunc(commentsHandler.Handle)))
		mux.Handle("/api/folder", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(uploadHandler.HandleFolder))))
		mux.Handle("/api/upload", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(uploadHandler.HandleUpload))))
		mux.Handle("/api/move", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(moveHandler.HandleMove))))
		mux.Handle("/api/search", authMiddleware.Wrap(http.HandlerFunc(searchHandler.HandleSearch)))
		mux.Handle("/api/files/", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleServeFile)))
	}

	// Multi-mode routes (require admin role for /admin/*, authenticated for /me)
	if multiMode {
		adminHandler := handlers.NewAdminHandler(userStore, grantStore, collabHub)
		meHandler := handlers.NewMeHandler(userStore, grantStore)

		mux.Handle("/api/admin/invite", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleInvite))))
		mux.Handle("/api/admin/users", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleUsers))))
		mux.Handle("/api/admin/grants", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleGrants))))
		mux.Handle("/api/me", authMiddleware.Wrap(http.HandlerFunc(meHandler.HandleMe)))

		// Admin: reset 2FA
		if totpHandler != nil {
			mux.Handle("/api/admin/reset-2fa", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(totpHandler.HandleAdminResetTOTP))))
		}
	}

	// Git sync endpoints (admin-only in multi mode, always allowed in single)
	syncHandler := handlers.NewSyncHandler(absNotesDir, searchHandler.InvalidateCache)
	if multiMode {
		mux.Handle("/api/admin/sync", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(syncHandler.HandleSync))))
		mux.Handle("/api/admin/sync-status", authMiddleware.Wrap(http.HandlerFunc(syncHandler.HandleSyncStatus)))
	} else {
		mux.Handle("/api/admin/sync", authMiddleware.Wrap(http.HandlerFunc(syncHandler.HandleSync)))
		mux.Handle("/api/admin/sync-status", authMiddleware.Wrap(http.HandlerFunc(syncHandler.HandleSyncStatus)))
	}

	// WebSocket route for live collaboration (no auth middleware — JWT verified in handler)
	if enableCollab {
		wsHandler := handlers.NewWSHandler(collabHub, jwtSecret)
		mux.HandleFunc("/api/ws", wsHandler.HandleWS)
	}

	// Trust all mounted directories for git operations
	exec.Command("git", "config", "--global", "safe.directory", "*").Run()

	handler := corsMiddleware.Wrap(mux)

	log.Printf("mdnest backend listening on :%s (NOTES_DIR=%s)", port, absNotesDir)
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		log.Fatal(err)
	}
}
