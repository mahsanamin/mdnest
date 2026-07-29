package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/mdnest/mdnest/backend/collab"
	"github.com/mdnest/mdnest/backend/firebase"
	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/sso"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
	"github.com/mdnest/mdnest/backend/updates"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envInt reads an integer env var, falling back to the given default if
// unset or unparseable.
func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Printf("WARNING: %s=%q is not a valid integer, using default %d", key, v, fallback)
		return fallback
	}
	return n
}

func main() {
	// Support -migrate flag for running migrations only (then exit)
	migrateOnly := len(os.Args) > 1 && os.Args[1] == "-migrate"
	// Support -reset-password <email> for ops-side recovery (then exit).
	// Reads the new password from stdin so it never lands in shell history.
	resetPasswordEmail := ""
	if len(os.Args) > 2 && os.Args[1] == "-reset-password" {
		resetPasswordEmail = os.Args[2]
	}
	// Support -create-token <name> for host-side API token provisioning
	// (then exit). Useful when an operator wants to wire an external
	// agent / CLI / script without going through the web UI's
	// Settings → API Tokens flow. Prints just the raw token to stdout
	// so callers can capture it: `TOKEN=$(./mdnest -create-token open-claw)`.
	createTokenName := ""
	if len(os.Args) > 2 && os.Args[1] == "-create-token" {
		createTokenName = os.Args[2]
	}

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

	// Storage backend for note data (local filesystem by default). Note
	// history and git-sync always operate on the local filesystem regardless
	// of this setting — they are orthogonal, optional features.
	stg, err := storage.FromEnv(context.Background(), absNotesDir)
	if err != nil {
		log.Fatalf("failed to initialize storage backend: %v", err)
	}
	log.Printf("storage backend: %s", stg.Kind())

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

		if resetPasswordEmail != "" {
			runResetPassword(db, resetPasswordEmail)
			return
		}
	} else {
		if migrateOnly {
			log.Fatal("ERROR: -migrate flag requires AUTH_MODE=multi")
		}
		if resetPasswordEmail != "" {
			log.Fatal("ERROR: -reset-password requires AUTH_MODE=multi")
		}
		log.Println("AUTH_MODE=single — file-based auth (no database)")
	}

	secretsDir := env("SECRETS_DIR", filepath.Join(absNotesDir, ".secrets"))
	multiMode := authMode == "multi"

	// -create-token <name> short-circuit. Generates an API token, persists
	// it to secretsDir/tokens.json (the same store the HTTP token API
	// uses), prints just the raw token to stdout, and exits. Other log
	// noise goes to stderr so callers can `TOKEN=$(... -create-token ...)`
	// safely. Multi-mode tokens are owned by users — if the caller wants
	// per-user multi-mode tokens, they can use the web UI; the host-side
	// CLI here always creates a single-mode-style token (UserID=0,
	// resolved as the default admin context by the auth middleware).
	if createTokenName != "" {
		// Multi-mode tokens MUST be bound to a user — without it, the
		// auth middleware can't resolve a UserContext and every
		// permission-gated request would 403. We refuse rather than
		// silently mint a useless / footgun token. Multi-mode operators
		// can create tokens via the web UI (Settings → API Tokens),
		// which binds them to the logged-in user automatically.
		if multiMode {
			log.Fatalf("ERROR: -create-token requires AUTH_MODE=single. " +
				"Multi-mode tokens are owned by users and must be created via " +
				"the web UI (Settings → API Tokens) so they bind to your account.")
		}
		if err := os.MkdirAll(secretsDir, 0700); err != nil {
			log.Fatalf("ERROR: failed to create secrets dir: %v", err)
		}
		th := handlers.NewTokenHandler(secretsDir)
		// Single mode: bind the token to MDNEST_USER for clarity in
		// logs/UI. UserID stays 0 because there's no DB user table —
		// the auth middleware skips per-user resolution in single mode
		// anyway, so the security posture is identical to web-UI-
		// created tokens (same hash check, same trust scope).
		token, _, err := th.CreateAPIToken(createTokenName, 0, user, "")
		if err != nil {
			log.Fatalf("ERROR: failed to create token: %v", err)
		}
		// Raw token to stdout (and ONLY the raw token); meta to stderr so
		// shell capture is clean.
		log.Printf("API token '%s' created (owner: %s) — copy it now, it won't be shown again", createTokenName, user)
		fmt.Println(token)
		return
	}

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

	// Opt-in: auto-create a least-privilege collaborator for an unknown but
	// IdP-authenticated email on first SSO login, instead of rejecting it.
	// Off by default; only meaningful when USER_PROVIDER=sso.
	ssoAutoProvisionUsers := env("SSO_AUTOPROVISION_USERS", "false") == "true"
	if ssoAutoProvisionUsers {
		log.Println("SSO user auto-provisioning: enabled")
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
			// Seed the bootstrap account as superadmin (global role), NOT the
			// literal "admin". Since v3.5.0 the role model is three-tier:
			// superadmin (global), admin (scoped to namespace_admins rows),
			// collaborator (per-grant). A seeded "admin" has no namespace_admins
			// rows and no grants, so FilterNamespaces returns [] — a fresh
			// multi-mode install would show zero namespaces and no way to grant
			// access. Migration 007 only rewrites pre-existing admin rows, not
			// ones the seed creates after it runs. The first account is the
			// operator by definition; the count==0 guard keeps this to that one
			// user, so later invitees are unaffected.
			_, err := userStore.CreateUser(email, user, password, "superadmin", nil)
			if err != nil {
				log.Fatalf("failed to seed admin user: %v", err)
			}
			log.Printf("seeded superadmin user: %s (%s)", user, email)
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
		// As of v3.5.0 these emails are promoted to superadmin (global), not
		// the new namespace-scoped admin role.
		adminEmails := parseAdminEmails(env("ADMIN_EMAILS", ""))
		for email := range adminEmails {
			if promoted, err := userStore.PromoteToSuperAdmin(email); err != nil {
				log.Printf("admin email reconcile failed for %s: %v", email, err)
			} else if promoted {
				log.Printf("ADMIN_EMAILS: promoted %s to superadmin", email)
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
	var nsAdminStore store.NamespaceAdminStore
	if multiMode {
		grantStore = store.NewPostgresGrantStore(db)
		nsAdminStore = store.NewPostgresNamespaceAdminStore(db)
		perms = middleware.NewPermissionChecker(grantStore, nsAdminStore)
	}

	// Live collaboration hub (optional, multi mode only)
	enableCollab := multiMode && env("ENABLE_LIVE_COLLAB", "false") == "true"
	var collabHub *collab.Hub
	if enableCollab {
		collabHub = collab.NewHub()
		// Opt-in horizontal scaling: when REDIS_URL is set, share live events
		// and presence across replicas via a Redis pub/sub backplane. Empty =
		// single-instance behavior, unchanged.
		if redisURL := env("REDIS_URL", ""); redisURL != "" {
			if err := collabHub.EnableRedis(context.Background(), redisURL); err != nil {
				log.Fatalf("live collaboration: failed to enable Redis backplane: %v", err)
			}
		}
		log.Println("live collaboration enabled (WebSocket)")
	}

	nsHandler := handlers.NewNamespaceHandler(stg, perms)
	noteHandler := handlers.NewNoteHandler(stg)
	historyHandler := handlers.NewHistoryHandler(absNotesDir)
	if collabHub != nil {
		noteHandler.SetCollabHub(collabHub)
	}
	treeHandler := handlers.NewTreeHandler(stg, grantStore)
	uploadHandler := handlers.NewUploadHandler(stg, perms)
	moveHandler := handlers.NewMoveHandler(stg)
	searchHandler := handlers.NewSearchHandler(stg)
	tokenHandler := handlers.NewTokenHandler(secretsDir)
	// Comments require both a real user identity and the WebSocket hub for
	// live refresh on other clients, so we gate on enableCollab (which
	// itself implies multiMode). In single mode or collab-off deployments
	// the route is never registered → clean 404 for any caller.
	var commentsHandler *handlers.CommentsHandler
	if enableCollab {
		commentsHandler = handlers.NewCommentsHandler(stg)
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

	// GRANT_MAX_DEPTH bounds how deep into a namespace tree a grant's
	// path can target. "/" = depth 0 and is always allowed; "/a/b" = 2,
	// etc. Default 3, which covers most real-world structures (top
	// folder + one or two layers) without letting operators create
	// hard-to-audit scoped grants. Set to 0 (or negative) for no limit.
	grantMaxDepth := envInt("GRANT_MAX_DEPTH", 3)
	if grantMaxDepth < 0 {
		grantMaxDepth = 0
	}
	if grantMaxDepth > 0 {
		log.Printf("GRANT_MAX_DEPTH=%d — grants on paths deeper than this will be rejected", grantMaxDepth)
	} else {
		log.Println("GRANT_MAX_DEPTH=0 — no depth limit on grant paths")
	}

	configHandler := handlers.NewConfigHandler(authMode, enableCollab, serverAlias, require2FA)
	configHandler.SetGrantMaxDepth(grantMaxDepth)

	// Update-availability check — opt out by setting DISABLE_UPDATE_CHECK=true.
	// One HTTPS GET to api.github.com per server every hour; failures are
	// silent (logged at info level) so air-gapped installs aren't noisy.
	if env("DISABLE_UPDATE_CHECK", "false") != "true" {
		updateChecker := updates.New(env("UPDATE_CHECK_REPO", ""))
		updateChecker.Start(context.Background())
		configHandler.SetUpdateChecker(updateChecker)
	}
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

	// INSECURE_DEV_LOGIN backdoor: only honored when the env var is true
	// AND we're in multi mode (no users table = nothing to look up). Off
	// by default. The route below is registered only when the flag is on,
	// and /api/config exposes a devLoginEnabled boolean so the frontend
	// can render the dev-login page + a sticky warning bar.
	devLoginEnabled := multiMode && env("INSECURE_DEV_LOGIN", "false") == "true"
	if devLoginEnabled {
		log.Println("===========================================================")
		log.Println("WARNING: INSECURE_DEV_LOGIN=true — /api/auth/dev-login is")
		log.Println("active. ANY existing user can be impersonated by email")
		log.Println("without OAuth. NEVER enable this on a non-local deployment.")
		log.Println("===========================================================")
		configHandler.SetDevLoginEnabled(true)
	}
	mux.HandleFunc("/api/config", configHandler.HandleConfig)

	// SSO routes — only registered when an SSO client was built at startup.
	// Both endpoints are unauthenticated (that's the whole point), but the
	// state cookie + HMAC ensures we can't be tricked into minting tokens
	// from a replayed callback.
	if ssoClient != nil {
		// Optional allowlist of extra origins the SSO handoff may target, in
		// addition to the frontend. Used by the MCP OAuth bridge so the minted
		// JWT can be handed to the MCP server's callback. Comma-separated
		// absolute origins, e.g. "https://mdnest-mcp.example.com".
		var ssoReturnOrigins []string
		for _, o := range strings.Split(env("SSO_ALLOWED_RETURN_ORIGINS", ""), ",") {
			if o = strings.TrimSpace(o); o != "" {
				ssoReturnOrigins = append(ssoReturnOrigins, o)
			}
		}
		ssoHandler := handlers.NewSSOHandler(
			ssoClient, userStore, jwtSecret,
			strings.TrimRight(frontendOrigin, "/"),
			strings.HasPrefix(frontendOrigin, "https://"),
			ssoReturnOrigins,
			ssoAutoProvisionUsers,
		)
		mux.HandleFunc("/api/auth/sso/start", ssoHandler.HandleStart)
		mux.HandleFunc("/api/auth/sso/callback", ssoHandler.HandleCallback)
	}
	// Dev-only backdoor route — registered only when INSECURE_DEV_LOGIN
	// is set, otherwise this URL 404s like any other non-existent path.
	if devLoginEnabled {
		devLoginHandler := handlers.NewDevLoginHandler(userStore, jwtSecret)
		mux.HandleFunc("/api/auth/dev-login", devLoginHandler.HandleDevLogin)
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
		// History endpoints — read-only, gate on read access (anyone who
		// can read the file can see its version history).
		mux.Handle("/api/note/history", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(historyHandler.HandleHistory))))
		mux.Handle("/api/note/at", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(historyHandler.HandleNoteAt))))
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
		// History endpoints work in single mode too — git-sync runs
		// orthogonally to AUTH_MODE.
		mux.Handle("/api/note/history", authMiddleware.Wrap(http.HandlerFunc(historyHandler.HandleHistory)))
		mux.Handle("/api/note/at", authMiddleware.Wrap(http.HandlerFunc(historyHandler.HandleNoteAt)))
		// /api/comments intentionally unregistered in single mode.
		mux.Handle("/api/folder", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(uploadHandler.HandleFolder))))
		mux.Handle("/api/upload", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(uploadHandler.HandleUpload))))
		mux.Handle("/api/move", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(moveHandler.HandleMove))))
		mux.Handle("/api/search", authMiddleware.Wrap(http.HandlerFunc(searchHandler.HandleSearch)))
		mux.Handle("/api/files/", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleServeFile)))
	}

	// Multi-mode routes (require admin role for /admin/*, authenticated for /me)
	if multiMode {
		adminHandler := handlers.NewAdminHandler(userStore, grantStore, nsAdminStore, collabHub, userProvider, grantMaxDepth)
		meHandler := handlers.NewMeHandler(userStore, grantStore, nsAdminStore)

		// Admin endpoints: outer gate is RequireAdmin (= any admin role).
		// Per-namespace scoping is done inside each handler so namespace
		// admins are limited to their own namespaces while superadmins
		// see / mutate everything.
		mux.Handle("/api/admin/invite", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleInvite))))
		mux.Handle("/api/admin/grants", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleGrants))))
		mux.Handle("/api/admin/namespace-admins", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleNamespaceAdmins))))
		mux.Handle("/api/me", authMiddleware.Wrap(http.HandlerFunc(meHandler.HandleMe)))

		// Users endpoint: GET is RequireAdmin (handler scopes the list);
		// PUT/DELETE (role change, user delete) are SuperAdmin-only —
		// dispatched inside HandleUsers, but we lock the route shape too
		// by gating with RequireAdmin and letting the handler 403 on
		// non-superadmin role/delete. We keep RequireAdmin here because
		// the GET path is allowed for namespace admins.
		mux.Handle("/api/admin/users", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleUsers))))

		// Reset 2FA is global — superadmin only.
		if totpHandler != nil {
			mux.Handle("/api/admin/reset-2fa", authMiddleware.Wrap(middleware.RequireSuperAdmin(http.HandlerFunc(totpHandler.HandleAdminResetTOTP))))
		}

		// Password reset: superadmin-only. The handler additionally rejects
		// resetting other superadmins' passwords — that case must go through
		// the host-side mdnest-server reset-password CLI.
		mux.Handle("/api/admin/reset-password", authMiddleware.Wrap(middleware.RequireSuperAdmin(http.HandlerFunc(adminHandler.HandleResetPassword))))
	}

	// Git sync endpoints (admin-only in multi mode, always allowed in single)
	syncHandler := handlers.NewSyncHandler(absNotesDir, searchHandler.InvalidateCache, nsAdminStore)
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

// runResetPassword resets a user's password from the host shell. Reads the
// new password from stdin (one line) so it never appears in argv / history,
// then writes a bcrypt hash and forces must_change_password=true so the
// user is prompted to pick their own on next login. Local-provider only —
// Firebase / SSO accounts have no local password to reset.
func runResetPassword(db *store.DB, email string) {
	provider := env("USER_PROVIDER", "local")
	if provider != "local" {
		log.Fatalf("ERROR: -reset-password is only valid for USER_PROVIDER=local (this server uses %q)", provider)
	}

	userStore := store.NewPostgresUserStore(db)
	user, err := userStore.GetUserByEmail(email)
	if err != nil {
		log.Fatalf("ERROR: failed to look up user: %v", err)
	}
	if user == nil {
		log.Fatalf("ERROR: no user found with email %q", email)
	}

	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil {
		log.Fatalf("ERROR: failed to read password from stdin: %v", err)
	}
	newPassword := strings.TrimRight(line, "\r\n")
	if newPassword == "" {
		log.Fatal("ERROR: empty password")
	}

	if err := userStore.AdminResetPassword(user.ID, newPassword); err != nil {
		log.Fatalf("ERROR: failed to reset password: %v", err)
	}
	fmt.Printf("Password reset for %s (id=%d). They will be required to choose a new one on next login.\n", user.Email, user.ID)
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
