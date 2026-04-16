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
			ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT false;
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
