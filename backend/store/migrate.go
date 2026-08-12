package store

import (
	"fmt"
	"log"
)

// migrations is an ordered list of SQL statements.
// Each entry runs once. We track applied migrations by sequence number
// in a simple migrations table.
var migrations = []struct {
	name string
	sql  string
}{
	{
		name: "001_create_users",
		sql: `
			CREATE TABLE IF NOT EXISTS users (
				id            SERIAL PRIMARY KEY,
				email         TEXT UNIQUE NOT NULL,
				username      TEXT UNIQUE NOT NULL,
				password_hash TEXT NOT NULL,
				role          TEXT NOT NULL DEFAULT 'collaborator',
				invited_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
			);
		`,
	},
	{
		name: "002_create_access_grants",
		sql: `
			CREATE TABLE IF NOT EXISTS access_grants (
				id          SERIAL PRIMARY KEY,
				user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				namespace   TEXT NOT NULL,
				path        TEXT NOT NULL DEFAULT '/',
				permission  TEXT NOT NULL DEFAULT 'write',
				granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
				UNIQUE(user_id, namespace, path)
			);
			CREATE INDEX IF NOT EXISTS idx_access_grants_user_id ON access_grants(user_id);
			CREATE INDEX IF NOT EXISTS idx_access_grants_namespace ON access_grants(namespace);
		`,
	},
	{
		name: "003_add_2fa_and_password_fields",
		sql: `
			ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
			ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
			ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;
			ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_codes TEXT;
		`,
	},
	{
		name: "004_add_blocked",
		sql: `
			ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false;
		`,
	},
	{
		// Federated identity: Firebase Auth becomes the identity source, but
		// authorization (role, grants, blocked) stays per-server in Postgres.
		// Additive-only — safe on local-mode deployments that never enable
		// Firebase. Existing rows keep their username/password_hash values;
		// we just drop the NOT NULL so Firebase-claimed rows don't require them.
		name: "005_add_firebase_uid",
		sql: `
			ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT UNIQUE;
			ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
			ALTER TABLE users ALTER COLUMN username DROP NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);
			CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
		`,
	},
	{
		// Profile metadata from federated identity providers (SSO `picture` and
		// `name` claims, Firebase displayName / photoURL). Used by the frontend
		// to render the user's actual face + name in the sidebar instead of
		// the "?" placeholder. Plain TEXT, no constraints — IdP URLs are
		// arbitrary HTTPS, names can be any unicode.
		name: "006_add_avatar_url",
		sql: `
			ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
		`,
	},
	{
		// Three-tier role hierarchy: superadmin (global) / admin (per
		// namespace via namespace_admins) / collaborator (grants only).
		// Existing global admins are renamed to superadmin so they keep
		// the all-namespaces bypass. New admins post-upgrade are
		// namespace-scoped — their administrative powers depend on rows
		// in namespace_admins, and they get an implicit write grant on
		// the namespaces they admin (created by the promote handler).
		name: "007_namespace_admins",
		sql: `
			UPDATE users SET role = 'superadmin' WHERE role = 'admin';

			CREATE TABLE IF NOT EXISTS namespace_admins (
				user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				namespace  TEXT NOT NULL,
				granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				PRIMARY KEY (user_id, namespace)
			);
			CREATE INDEX IF NOT EXISTS idx_namespace_admins_namespace ON namespace_admins(namespace);
		`,
	},
	{
		// API/MCP tokens move from the tokens.json file into Postgres in
		// multi mode, so a multi-replica deployment shares them through the
		// database instead of a ReadWriteMany secrets volume. Single mode is
		// unaffected — it keeps the file backend. user_id is the owner (NULL
		// for legacy/single-mode-style tokens); username/role are resolved by
		// joining users at read time.
		name: "008_api_tokens",
		sql: `
			CREATE TABLE IF NOT EXISTS api_tokens (
				id           TEXT PRIMARY KEY,
				name         TEXT NOT NULL,
				token_hash   TEXT UNIQUE NOT NULL,
				token_suffix TEXT NOT NULL,
				user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
				created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS idx_api_tokens_user_id ON api_tokens(user_id);
		`,
	},
	{
		// Per-workspace git remote config (multi mode, opt-in). A row overrides
		// the coarse env-based mirror default (GIT_REMOTE_URL) for one
		// namespace: notes in that workspace mirror to a specific repository
		// over HTTPS (PAT) or SSH (deploy key), instead of the group default.
		//
		// owner_id NULL  = a shared/team workspace configured by an admin.
		// is_personal    = a user's personal workspace (owner_id = that user),
		//                  excluded from the grants model (the owner has
		//                  implicit access; it is never listed in admin grant
		//                  UIs). The partial unique index caps it at one per
		//                  user. credential_encrypted holds the PAT or SSH
		//                  private key sealed with AES-256-GCM (see
		//                  backend/secrets); known_hosts is public host-key
		//                  material for SSH StrictHostKeyChecking and stays
		//                  plaintext.
		name: "009_create_workspaces",
		sql: `
			CREATE TABLE IF NOT EXISTS workspaces (
				id                   SERIAL PRIMARY KEY,
				namespace            TEXT NOT NULL UNIQUE,
				owner_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
				is_personal          BOOLEAN NOT NULL DEFAULT false,
				git_enabled          BOOLEAN NOT NULL DEFAULT false,
				transport            TEXT NOT NULL DEFAULT 'https',
				remote_url           TEXT NOT NULL DEFAULT '',
				username             TEXT NOT NULL DEFAULT 'oauth2',
				branch               TEXT NOT NULL DEFAULT 'main',
				known_hosts          TEXT NOT NULL DEFAULT '',
				credential_encrypted TEXT NOT NULL DEFAULT '',
				created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS idx_workspaces_owner_id ON workspaces(owner_id);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_personal_owner
				ON workspaces(owner_id) WHERE is_personal;
		`,
	},
	{
		// Workspace groups: a shared git remote base (the DB/UI equivalent of the
		// GIT_REMOTE_URL env provisioning). Workspaces created in a group inherit
		// its transport/base/credential and mirror to <base_url>/<namespace>.git,
		// so an operator declares the base + token once and adds namespaces to it.
		// workspaces.group_id links a namespace to its group; ON DELETE CASCADE so
		// removing a group removes its members' mirror config (never the notes).
		name: "010_create_workspace_groups",
		sql: `
			CREATE TABLE IF NOT EXISTS workspace_groups (
				id                   SERIAL PRIMARY KEY,
				name                 TEXT NOT NULL UNIQUE,
				transport            TEXT NOT NULL DEFAULT 'https',
				base_url             TEXT NOT NULL,
				username             TEXT NOT NULL DEFAULT 'oauth2',
				branch               TEXT NOT NULL DEFAULT 'main',
				known_hosts          TEXT NOT NULL DEFAULT '',
				credential_encrypted TEXT NOT NULL DEFAULT '',
				created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS group_id INTEGER
				REFERENCES workspace_groups(id) ON DELETE CASCADE;
			CREATE INDEX IF NOT EXISTS idx_workspaces_group_id ON workspaces(group_id);
		`,
	},
	{
		// Per-namespace mirror sync status: the durability writer records the
		// outcome of the last two-way sync on the workspace row so the owner sees
		// why mirroring is failing (bad token, missing branch, unreachable remote)
		// instead of a silently-empty namespace. last_sync_error is '' on success.
		name: "011_workspace_sync_status",
		sql: `
			ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_sync_error TEXT NOT NULL DEFAULT '';
			ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ;
		`,
	},
	{
		// A group's provenance. 'ui' groups are created and fully managed by a
		// superadmin from the admin panel. 'provisioned' groups are reconciled on
		// boot from operator config (GIT_REMOTE_URL + token): the admin panel may
		// only manage their sub-projects (add/remove namespaces), never edit or
		// delete the group itself, since it is owned by the deployment.
		name: "012_workspace_group_source",
		sql: `
			ALTER TABLE workspace_groups ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ui';
		`,
	},
	{
		// Role-based access ("Groups"): named, superadmin-managed sets whose
		// members are either mdnest users or IdP (OIDC) group IDs, and which
		// carry namespace grants that mirror access_grants. Access becomes the
		// union of a user's own grants and the grants of every group they
		// belong to. Fully additive: with no rows, behaviour is unchanged.
		name: "013_create_access_groups",
		sql: `
			CREATE TABLE IF NOT EXISTS access_groups (
				id          SERIAL PRIMARY KEY,
				name        TEXT UNIQUE NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			CREATE TABLE IF NOT EXISTS access_group_members (
				group_id   INTEGER NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
				user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
				oidc_group TEXT,
				-- optional human label for an OIDC group id (display only; the
				-- code matches on oidc_group, never on this)
				oidc_group_label TEXT NOT NULL DEFAULT '',
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				-- exactly one of user_id / oidc_group is set
				CHECK ((user_id IS NULL) <> (oidc_group IS NULL))
			);
			CREATE UNIQUE INDEX IF NOT EXISTS idx_access_group_members_user
				ON access_group_members(group_id, user_id) WHERE user_id IS NOT NULL;
			CREATE UNIQUE INDEX IF NOT EXISTS idx_access_group_members_oidc
				ON access_group_members(group_id, oidc_group) WHERE oidc_group IS NOT NULL;
			CREATE INDEX IF NOT EXISTS idx_access_group_members_uid ON access_group_members(user_id);
			CREATE INDEX IF NOT EXISTS idx_access_group_members_gid ON access_group_members(group_id);
			CREATE TABLE IF NOT EXISTS access_group_grants (
				id          SERIAL PRIMARY KEY,
				group_id    INTEGER NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
				namespace   TEXT NOT NULL,
				path        TEXT NOT NULL DEFAULT '/',
				permission  TEXT NOT NULL DEFAULT 'write',
				granted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
				created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
				UNIQUE(group_id, namespace, path)
			);
			CREATE INDEX IF NOT EXISTS idx_access_group_grants_group ON access_group_grants(group_id);
			CREATE INDEX IF NOT EXISTS idx_access_group_grants_ns ON access_group_grants(namespace);
		`,
	},
}

// Migrate runs all pending migrations. Safe to call on every startup.
func (db *DB) Migrate() error {
	// Create migrations tracking table
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			id         SERIAL PRIMARY KEY,
			name       TEXT UNIQUE NOT NULL,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
	`)
	if err != nil {
		return fmt.Errorf("failed to create migrations table: %w", err)
	}

	for _, m := range migrations {
		// Check if already applied
		var exists bool
		err := db.QueryRow("SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE name = $1)", m.name).Scan(&exists)
		if err != nil {
			return fmt.Errorf("failed to check migration %s: %w", m.name, err)
		}
		if exists {
			continue
		}

		// Apply migration
		log.Printf("applying migration: %s", m.name)
		if _, err := db.Exec(m.sql); err != nil {
			return fmt.Errorf("migration %s failed: %w", m.name, err)
		}

		// Record it
		if _, err := db.Exec("INSERT INTO schema_migrations (name) VALUES ($1)", m.name); err != nil {
			return fmt.Errorf("failed to record migration %s: %w", m.name, err)
		}

		log.Printf("migration applied: %s", m.name)
	}

	log.Println("database schema is up to date")
	return nil
}
