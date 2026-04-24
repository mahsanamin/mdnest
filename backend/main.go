package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/firebase"
	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/sso"
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

	// Federated identity (optional, multi-mode only).
	//   firebase: Firebase Auth + Firestore for TOTP (enrollment shared across
	//             mdnest servers sharing a Firebase project).
	//   sso     : Generic OIDC (Google, Okta, etc.). Email → existing mdnest
	//             user; 2FA is skipped (the IdP owns MFA).
	//   local   : built-in username/password + Postgres TOTP (default).
	userProvider := env("USER_PROVIDER", "local")
	switch userProvider {
	case "local", "firebase", "sso":
		// ok
	default:
		log.Fatalf("USER_PROVIDER must be one of: local, firebase, sso (got %q)", userProvider)
	}
	if userProvider != "local" && !multiMode {
		log.Fatalf("USER_PROVIDER=%s requires AUTH_MODE=multi", userProvider)
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

	}

	// TOTP storage + SSO client: choose based on USER_PROVIDER.
	var totpStore store.TOTPStore
	var firebaseClient *firebase.Client
	var ssoClient *sso.Client
	if multiMode {
		switch userProvider {
		case "firebase":
			c, err := firebase.NewClient(context.Background(),
				env("FIREBASE_SERVICE_ACCOUNT", ""),
				env("FIREBASE_PROJECT_ID", ""))
			if err != nil {
				log.Fatalf("failed to init firebase client: %v", err)
			}
			firebaseClient = c
			totpStore = firebase.NewTOTPStore(c.Firestore, userStore)
			log.Println("USER_PROVIDER=firebase — federated identity via Firebase Auth")
		case "sso":
			// IdP owns MFA; we skip local 2FA entirely, so TOTPStore is
			// still wired (AuthHandler takes one) but becomes unused in
			// practice — Postgres-backed is safe as a no-op backing store.
			totpStore = store.NewPostgresTOTPStore(userStore)
			redirect := env("SSO_REDIRECT_URL", strings.TrimRight(frontendOrigin, "/")+"/api/auth/sso/callback")
			domains := parseAllowedDomains(env("SSO_ALLOWED_DOMAINS", ""))
			client, err := sso.NewClient(context.Background(), sso.Config{
				IssuerURL:      env("SSO_ISSUER_URL", ""),
				ClientID:       env("SSO_CLIENT_ID", ""),
				ClientSecret:   env("SSO_CLIENT_SECRET", ""),
				RedirectURL:    redirect,
				AllowedDomains: domains,
				CookieSecret:   []byte(jwtSecret),
			})
			if err != nil {
				log.Fatalf("failed to init SSO client: %v", err)
			}
			ssoClient = client
			log.Printf("USER_PROVIDER=sso — OIDC via %s (callback: %s)", env("SSO_ISSUER_URL", ""), redirect)
			if require2FA {
				log.Println("REQUIRE_2FA is ignored in SSO mode (the IdP owns MFA)")
				require2FA = false
			}
		default:
			totpStore = store.NewPostgresTOTPStore(userStore)
		}

		authHandler = handlers.NewMultiAuthHandler(jwtSecret, userStore, totpStore, require2FA)

		// Reconcile ADMIN_EMAILS on startup (idempotent). Emails removed from
		// the list are NOT auto-demoted — operator must demote explicitly.
		adminEmails := parseAdminEmails(env("ADMIN_EMAILS", ""))
		for email := range adminEmails {
			if promoted, err := userStore.PromoteToAdmin(email); err != nil {
				log.Printf("admin email reconcile failed for %s: %v", email, err)
			} else if promoted {
				log.Printf("ADMIN_EMAILS: promoted %s to admin", email)
			}
		}

		if firebaseClient != nil {
			authHandler.SetFirebase(firebaseClient, adminEmails)
		}
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
	// Comments require both a real user identity and the WebSocket hub for
	// live refresh on other clients, so we gate on enableCollab (which
	// itself implies multiMode). In single mode or collab-off deployments
	// the route is never registered → clean 404 for any caller.
	var commentsHandler *handlers.CommentsHandler
	if enableCollab {
		commentsHandler = handlers.NewCommentsHandler(absNotesDir)
	}

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
	if serverAlias == "" {
		log.Println("WARNING: SERVER_ALIAS is not set in mdnest.conf — the mdnest CLI will require users to pass an @alias manually when they log in. Add SERVER_ALIAS=<short-name> for automatic CLI alias resolution.")
	}
	configHandler := handlers.NewConfigHandler(authMode, enableCollab, serverAlias, require2FA)
	if firebaseClient != nil {
		webCfg, err := readFirebaseWebConfig(env("FIREBASE_WEB_CONFIG", ""))
		if err != nil {
			log.Fatalf("failed to read FIREBASE_WEB_CONFIG: %v", err)
		}
		configHandler.SetFirebase(webCfg)
	}
	if ssoClient != nil {
		configHandler.SetSSO(env("SSO_PROVIDER_LABEL", "SSO"))
	}
	mux.HandleFunc("/api/config", configHandler.HandleConfig)

	// SSO routes — only registered when an SSO client was built at startup.
	// Both endpoints are unauthenticated (that's the whole point), but the
	// state cookie + HMAC ensures we can't be tricked into minting tokens
	// from a replayed callback.
	if ssoClient != nil {
		ssoHandler := handlers.NewSSOHandler(
			ssoClient, userStore, jwtSecret,
			strings.TrimRight(frontendOrigin, "/"),
			strings.HasPrefix(frontendOrigin, "https://"),
		)
		mux.HandleFunc("/api/auth/sso/start", ssoHandler.HandleStart)
		mux.HandleFunc("/api/auth/sso/callback", ssoHandler.HandleCallback)
	}
	mux.HandleFunc("/api/auth/login", authHandler.Login)
	mux.Handle("/api/auth/change-password", authMiddleware.Wrap(http.HandlerFunc(authHandler.ChangePassword)))
	mux.HandleFunc("/api/auth/change-password-forced", authHandler.HandleForcedPasswordChange)
	mux.Handle("/api/auth/tokens", authMiddleware.Wrap(http.HandlerFunc(tokenHandler.HandleTokens)))

	// TOTP / 2FA routes (multi mode only, and not in SSO mode — the IdP owns MFA).
	var totpHandler *handlers.TOTPHandler
	if multiMode && userProvider != "sso" {
		totpIssuer := env("TOTP_ISSUER", "mdnest")
		totpHandler = handlers.NewTOTPHandler(jwtSecret, userStore, totpStore, totpIssuer)
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
		if commentsHandler != nil {
			mux.Handle("/api/comments", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(commentsHandler.Handle))))
		}
		mux.Handle("/api/folder", authMiddleware.Wrap(perms.RequireWrite(invalidateSearch(http.HandlerFunc(uploadHandler.HandleFolder)))))
		mux.Handle("/api/upload", authMiddleware.Wrap(perms.RequireWrite(invalidateSearch(http.HandlerFunc(uploadHandler.HandleUpload)))))
		mux.Handle("/api/move", authMiddleware.Wrap(perms.RequireMove(invalidateSearch(http.HandlerFunc(moveHandler.HandleMove)))))
		mux.Handle("/api/search", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(searchHandler.HandleSearch))))
		mux.Handle("/api/files/", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleServeFile))) // files endpoint extracts ns from URL, handled differently
	} else {
		mux.Handle("/api/namespaces", authMiddleware.Wrap(http.HandlerFunc(nsHandler.ListNamespaces)))
		mux.Handle("/api/tree", authMiddleware.Wrap(http.HandlerFunc(treeHandler.GetTree)))
		mux.Handle("/api/note", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(noteHandler.Handle))))
		// /api/comments intentionally unregistered in single mode.
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

// parseAllowedDomains turns a comma-separated env string into a list of
// lowercased email domains for the SSO allowlist.
func parseAllowedDomains(s string) []string {
	out := []string{}
	for _, raw := range strings.Split(s, ",") {
		d := strings.ToLower(strings.TrimSpace(raw))
		if d != "" {
			out = append(out, d)
		}
	}
	return out
}

// parseAdminEmails turns a comma-separated env string into a lowercased
// set used by the Firebase claim path to bootstrap admin role.
func parseAdminEmails(s string) map[string]bool {
	out := map[string]bool{}
	for _, raw := range strings.Split(s, ",") {
		e := strings.ToLower(strings.TrimSpace(raw))
		if e != "" {
			out[e] = true
		}
	}
	return out
}

// readFirebaseWebConfig loads the Firebase web-config JSON file (the one
// you download from Project settings → Your apps → Web) so the backend
// can hand it to the frontend via /api/config. Keeping it here (rather
// than asking nginx to serve the file) means zero nginx config changes.
func readFirebaseWebConfig(path string) (map[string]interface{}, error) {
	if path == "" {
		return nil, os.ErrNotExist
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var out map[string]interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}
