package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

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

// readGitToken returns the coarse env-default git PAT used by the provisioned
// group, from GIT_TOKEN_FILE (preferred: a mounted Secret) or GIT_TOKEN. It
// returns "" when neither is set — the reconcile then keeps any previously
// sealed credential rather than clearing it.
func readGitToken() string {
	if f := strings.TrimSpace(os.Getenv("GIT_TOKEN_FILE")); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return strings.TrimSpace(os.Getenv("GIT_TOKEN"))
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
	// Secret used to seal per-workspace git credentials at rest (AES-256-GCM,
	// key derived via SHA-256). Falls back to the JWT secret so one existing
	// secret suffices. Rotating it makes previously-sealed credentials
	// undecryptable (no key-versioned envelope): owners must re-enter their
	// token / key — see docs/security.md.
	encryptionSecret := env("MDNEST_ENCRYPTION_KEY", jwtSecret)
	// A dedicated, non-default sealing secret is required to store per-workspace
	// git credentials (the most sensitive data mdnest holds). Without it the
	// workspace handler fails closed and refuses to enable mirroring, rather than
	// sealing PATs / SSH keys under a guessable default key.
	encryptionConfigured := strings.TrimSpace(encryptionSecret) != "" && encryptionSecret != "changeme"
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
	//
	// appCtx is cancelled on SIGINT/SIGTERM so the writer role releases its
	// leader lock promptly (fast failover) and the HTTP server shuts down
	// gracefully rather than being killed mid-request.
	appCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	// The per-workspace git remote resolver is DB-backed and only available
	// once multi-mode Postgres is connected (below), so it is wired lazily here
	// and its delegate is set after the workspace store is built.
	wsResolver := &storage.LazyResolver{}
	stg, err := storage.FromEnv(appCtx, absNotesDir, wsResolver)
	if err != nil {
		log.Fatalf("failed to initialize storage backend: %v", err)
	}
	log.Printf("storage backend: %s (role=%s)", stg.Kind(), env("MDNEST_ROLE", "single"))

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
		th := handlers.NewTokenHandler(store.NewFileTokenStore(secretsDir))
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
				GroupsClaim:    env("OIDC_GROUPS_CLAIM", ""),
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
	var groupStore store.GroupStore
	var workspaceStore store.WorkspaceStore
	if multiMode {
		grantStore = store.NewPostgresGrantStore(db)
		nsAdminStore = store.NewPostgresNamespaceAdminStore(db)
		groupStore = store.NewPostgresGroupStore(db)
		perms = middleware.NewPermissionChecker(grantStore, nsAdminStore, groupStore)

		// Per-workspace git remote overrides: the store decrypts credentials and
		// this adapter feeds the git committer, overriding the coarse
		// GIT_REMOTE_URL default per namespace.
		workspaceStore = store.NewPostgresWorkspaceStore(db, encryptionSecret)
		wsResolver.Set(storage.RemoteResolverFunc(func(ns string) (storage.RemoteSpec, bool, error) {
			r, err := workspaceStore.RemoteForNamespace(ns)
			if err != nil || r == nil {
				return storage.RemoteSpec{}, false, err
			}
			return storage.RemoteSpec{
				Transport:  r.Transport,
				RemoteURL:  r.RemoteURL,
				Username:   r.Username,
				Branch:     r.Branch,
				Credential: r.Credential,
				KnownHosts: r.KnownHosts,
			}, true, nil
		}))

		// The durability writer records each namespace's last mirror sync outcome
		// on its workspace row so the owner sees why mirroring fails (bad token,
		// missing branch, unreachable remote) instead of a silently-empty ns. Only
		// the writer/single git storage implements the sink; the app tier does not.
		if r, ok := stg.(interface {
			SetSyncStatusSink(storage.SyncStatusSink)
		}); ok {
			r.SetSyncStatusSink(workspaceStore)
		}

		// Reconcile the operator-provisioned workspace group from env. When a
		// coarse default remote is configured (GIT_REMOTE_URL — the same base the
		// env provisioning mirrors every namespace under), surface it as a
		// 'provisioned' group so a superadmin can see it and add sub-projects to
		// it, without being able to edit or delete a group the deployment owns.
		// Its credential is sealed into the DB row so grouped members resolve
		// through the same path as UI groups; skipped when the server has no
		// dedicated sealing secret (fail-closed, like the rest of mirroring).
		if encryptionConfigured {
			if base := strings.TrimRight(strings.TrimSpace(env("GIT_REMOTE_URL", "")), "/"); base != "" {
				spec := store.ProvisionedGroupSpec{
					Name:       env("GIT_PROVISIONED_GROUP_NAME", "Provisioned workspaces"),
					Transport:  "https",
					BaseURL:    base,
					Username:   env("GIT_REMOTE_USERNAME", "oauth2"),
					Branch:     env("GIT_REMOTE_BRANCH", "main"),
					Credential: readGitToken(),
				}
				if _, err := workspaceStore.EnsureProvisionedGroup(spec); err != nil {
					log.Printf("workspaces: could not reconcile provisioned group: %v", err)
				}
			}
		}
	}

	// Task board (optional, off by default). When disabled the /api/tasks and
	// /api/board routes are never registered — a clean 404 rather than a
	// half-present feature — and the frontend never loads the board chunk.
	enableTaskBoard := env("ENABLE_TASK_BOARD", "false") == "true"

	// Marp slides (optional, off by default). When enabled the frontend renders
	// a note whose frontmatter says `marp: true` as a slide deck in the Live view
	// instead of the editor; when disabled it never loads the Marp engine chunk.
	enableMarp := env("ENABLE_MARP", "false") == "true"
	// ENABLE_MARP_THEMES is a separate opt-in on top of ENABLE_MARP: the
	// centralized theme catalog (reserved namespace, seed, /api/marp/themes,
	// admin editor). Off by default so plain-Marp operators are unaffected.
	enableMarpThemes := enableMarp && env("ENABLE_MARP_THEMES", "false") == "true"

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

	nsHandler := handlers.NewNamespaceHandler(stg, perms, workspaceStore)
	noteHandler := handlers.NewNoteHandler(stg)
	historyHandler := handlers.NewHistoryHandler(absNotesDir)
	if collabHub != nil {
		noteHandler.SetCollabHub(collabHub)
	}
	treeHandler := handlers.NewTreeHandler(stg, grantStore)
	uploadHandler := handlers.NewUploadHandler(stg, perms)
	// Stateless app replicas own no attachment bytes: proxy attachment traffic
	// (upload + serve) to the writer, which owns the git tree, when WRITER_URL is
	// configured.
	if env("MDNEST_ROLE", "single") == "app" {
		if writerURL := env("WRITER_URL", ""); writerURL != "" {
			u, perr := url.Parse(writerURL)
			if perr != nil {
				log.Fatalf("invalid WRITER_URL %q: %v", writerURL, perr)
			}
			writerProxy := httputil.NewSingleHostReverseProxy(u)
			uploadHandler.SetWriterProxy(writerProxy)
			// The git tree — and therefore per-file commit history — lives only on
			// the writer, so history reads must be proxied there too. Without this,
			// an app replica finds no local .git/ and wrongly reports that history
			// is unavailable for the namespace.
			historyHandler.SetWriterProxy(writerProxy)
			log.Printf("attachments + history: proxying /api/upload, /api/files/, /api/note/history and /api/note/at to writer at %s", writerURL)
		} else {
			// Fail loud rather than come up Ready with silently broken
			// attachments: an app replica owns no attachment bytes, so upload
			// and serve only work when proxied to the writer.
			log.Fatalf("MDNEST_ROLE=app requires WRITER_URL — without it /api/upload and /api/files/ are broken while the pod still reports Ready")
		}
	}
	moveHandler := handlers.NewMoveHandler(stg)
	searchHandler := handlers.NewSearchHandler(stg)
	// The global (cross-namespace) task view is access-controlled entirely by
	// this filter. Multi mode enforces per-user access (perms.FilterNamespaces);
	// single mode has one owner of every namespace, so an explicit all-access
	// pass-through documents that intent and keeps the filter non-nil (a nil
	// filter fails closed and would serve nothing).
	var taskNsFilter func(r *http.Request, namespaces []string) []string
	if perms != nil {
		taskNsFilter = perms.FilterNamespaces
	} else {
		taskNsFilter = func(_ *http.Request, namespaces []string) []string { return namespaces }
	}
	taskHandler := handlers.NewTaskHandler(stg, taskNsFilter)
	// API tokens live in Postgres in multi mode (shared across replicas, no
	// ReadWriteMany secrets volume) and in the tokens.json file in single mode
	// (no database dependency for a single-box install).
	var tokenStore store.TokenStore
	if multiMode {
		tokenStore = store.NewPostgresTokenStore(db)
		// One-time, idempotent import so an existing multi-mode install keeps
		// its API tokens across the move from tokens.json to Postgres.
		if n, err := store.ImportFileTokens(db, secretsDir); err != nil {
			log.Printf("warning: could not import legacy tokens.json: %v", err)
		} else if n > 0 {
			log.Printf("imported %d API token(s) from tokens.json into Postgres", n)
		}
	} else {
		if err := os.MkdirAll(secretsDir, 0700); err != nil {
			log.Fatalf("failed to create secrets dir: %v", err)
		}
		tokenStore = store.NewFileTokenStore(secretsDir)
	}
	tokenHandler := handlers.NewTokenHandler(tokenStore)
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
	configHandler.SetTaskBoard(enableTaskBoard)
	configHandler.SetMarp(enableMarp)
	configHandler.SetMarpThemes(enableMarpThemes)

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
		mux.HandleFunc("/api/auth/verify-totp", totpHandler.HandleVerifyLoginTOTP)            // no auth — uses temp token
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
		// Task aggregation: GET reads notes, PATCH rewrites a task line in a note,
		// so route by method (read vs write) and invalidate the search cache on
		// mutation just like /api/note.
		if enableTaskBoard {
			mux.Handle("/api/tasks", authMiddleware.Wrap(perms.ReadWriteRouter(invalidateSearch(http.HandlerFunc(taskHandler.HandleTasks)))))
			mux.Handle("/api/board", authMiddleware.Wrap(perms.ReadWriteRouter(http.HandlerFunc(taskHandler.HandleBoard))))
			// Cross-namespace view: aggregates the caller's accessible namespaces.
			// Auth-only here — the handler self-filters via the namespace filter,
			// so it must not be wrapped in the single-namespace RequireNsAccess.
			mux.Handle("/api/tasks/all", authMiddleware.Wrap(http.HandlerFunc(taskHandler.HandleGlobalTasks)))
			// Namespace members for the task assignee picker. Read-access gated:
			// anyone who can see the namespace may list who else is on it.
			if pg, ok := grantStore.(*store.PostgresGrantStore); ok {
				teamHandler := handlers.NewTeamHandler(stg, pg)
				mux.Handle("/api/namespace/users", authMiddleware.Wrap(perms.RequireNsAccess(http.HandlerFunc(teamHandler.HandleNamespaceUsers))))
			}
		}
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
		if enableTaskBoard {
			mux.Handle("/api/tasks", authMiddleware.Wrap(invalidateSearch(http.HandlerFunc(taskHandler.HandleTasks))))
			mux.Handle("/api/board", authMiddleware.Wrap(http.HandlerFunc(taskHandler.HandleBoard)))
			// Single mode: one user owns every namespace, so the global view
			// aggregates them all (nil namespace filter).
			mux.Handle("/api/tasks/all", authMiddleware.Wrap(http.HandlerFunc(taskHandler.HandleGlobalTasks)))
		}
		mux.Handle("/api/files/", authMiddleware.Wrap(http.HandlerFunc(uploadHandler.HandleServeFile)))
	}

	// Centralized Marp themes: a global, read-for-all / write-for-superadmin
	// catalog stored in a reserved hidden namespace. Decks reference a theme by
	// name (`theme: <name>`) instead of embedding a per-deck style block. Opt-in
	// via ENABLE_MARP_THEMES (on top of ENABLE_MARP); available in both modes.
	if enableMarpThemes {
		marpThemeHandler := handlers.NewMarpThemeHandler(stg)
		mux.Handle("/api/marp/themes", authMiddleware.Wrap(http.HandlerFunc(marpThemeHandler.Handle)))
		// Seed the neutral starter theme once, from the node that owns the tree
		// (single or writer). App replicas read it from the coherence tier after
		// the writer hydrates the reserved namespace.
		if env("MDNEST_ROLE", "single") != "app" {
			marpThemeHandler.SeedDefault(context.Background())
		}
	}

	// Multi-mode routes (require admin role for /admin/*, authenticated for /me)
	if multiMode {
		adminHandler := handlers.NewAdminHandler(userStore, grantStore, nsAdminStore, collabHub, userProvider, grantMaxDepth)
		meHandler := handlers.NewMeHandler(userStore, grantStore, nsAdminStore)
		// Per-workspace git remote config: superadmin CRUD over shared/team
		// workspaces, plus each user's own personal workspace. The optional
		// GIT_REMOTE_ALLOWED_HOSTS restricts remote hosts (defence-in-depth for
		// SSRF; the primary control is the writer's egress NetworkPolicy).
		workspaceHandler := handlers.NewWorkspaceHandler(workspaceStore, userStore, grantStore, stg,
			strings.Split(env("GIT_REMOTE_ALLOWED_HOSTS", ""), ","), encryptionConfigured)
		workspaceHandler.SetNamespaceAdminCleaner(nsAdminStore)
		if !encryptionConfigured {
			log.Println("WARNING: MDNEST_ENCRYPTION_KEY is unset and MDNEST_JWT_SECRET is default — per-workspace git mirroring is disabled (credentials cannot be sealed at rest). Set MDNEST_ENCRYPTION_KEY to enable it.")
		}

		// Admin endpoints: outer gate is RequireAdmin (= any admin role).
		// Per-namespace scoping is done inside each handler so namespace
		// admins are limited to their own namespaces while superadmins
		// see / mutate everything.
		mux.Handle("/api/admin/invite", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleInvite))))
		mux.Handle("/api/admin/grants", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleGrants))))
		mux.Handle("/api/admin/namespace-admins", authMiddleware.Wrap(middleware.RequireAdmin(http.HandlerFunc(adminHandler.HandleNamespaceAdmins))))
		mux.Handle("/api/me", authMiddleware.Wrap(http.HandlerFunc(meHandler.HandleMe)))

		// Per-workspace git remotes: admin CRUD is superadmin-only (it manages
		// credentials); the personal workspace is self-service for any user.
		mux.Handle("/api/admin/workspaces", authMiddleware.Wrap(middleware.RequireSuperAdmin(http.HandlerFunc(workspaceHandler.HandleAdmin))))
		mux.Handle("/api/admin/workspace-groups", authMiddleware.Wrap(middleware.RequireSuperAdmin(http.HandlerFunc(workspaceHandler.HandleGroups))))
		mux.Handle("/api/me/workspace", authMiddleware.Wrap(http.HandlerFunc(workspaceHandler.HandleMine)))

		// Role-based access "Groups": superadmin-only management of named sets
		// (users + OIDC group IDs) and their namespace grants.
		groupsHandler := handlers.NewGroupsHandler(groupStore)
		mux.Handle("/api/admin/groups", authMiddleware.Wrap(middleware.RequireSuperAdmin(http.HandlerFunc(groupsHandler.HandleGroups))))
		mux.Handle("/api/admin/groups/members", authMiddleware.Wrap(middleware.RequireSuperAdmin(http.HandlerFunc(groupsHandler.HandleMembers))))
		mux.Handle("/api/admin/groups/grants", authMiddleware.Wrap(middleware.RequireSuperAdmin(http.HandlerFunc(groupsHandler.HandleGrants))))

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

	srv := &http.Server{Addr: ":" + port, Handler: handler}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server error: %v", err)
		}
	}()
	log.Printf("mdnest backend listening on :%s (NOTES_DIR=%s)", port, absNotesDir)

	<-appCtx.Done()
	log.Println("shutdown signal received, draining…")
	shutCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Printf("graceful shutdown error: %v", err)
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
