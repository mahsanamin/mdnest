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
