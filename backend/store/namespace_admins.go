package store

import (
	"database/sql"
	"fmt"
	"time"
)

// NamespaceAdmin represents one row in namespace_admins: a per-namespace
// administrative grant. A user with role='admin' draws their administrative
// powers (invite, manage grants, promote co-admins) from the rows in this
// table — they can administer only the namespaces they have a row for.
//
// SuperAdmins (role='superadmin') don't need rows here; they bypass.
type NamespaceAdmin struct {
	UserID    int
	Namespace string
	GrantedBy *int
	CreatedAt time.Time
}

// NamespaceAdminWithUser is a row joined with the user's username for
// display in the admin panel.
type NamespaceAdminWithUser struct {
	NamespaceAdmin
	Username string
	Email    string
}

// NamespaceAdminStore defines per-namespace admin operations.
type NamespaceAdminStore interface {
	Add(userID int, namespace string, grantedBy *int) error
	Remove(userID int, namespace string) error
	DeleteAllForNamespace(namespace string) (int64, error)
	IsAdminOf(userID int, namespace string) (bool, error)
	ListByUser(userID int) ([]string, error)
	ListByNamespace(namespace string) ([]NamespaceAdminWithUser, error)
	CountByUser(userID int) (int, error)
}

// PostgresNamespaceAdminStore implements NamespaceAdminStore against Postgres.
type PostgresNamespaceAdminStore struct {
	db *DB
}

// NewPostgresNamespaceAdminStore creates a new store.
func NewPostgresNamespaceAdminStore(db *DB) *PostgresNamespaceAdminStore {
	return &PostgresNamespaceAdminStore{db: db}
}

// Add inserts a (user_id, namespace) pair. Idempotent — re-adding an
// existing pair is a no-op (no error).
func (s *PostgresNamespaceAdminStore) Add(userID int, namespace string, grantedBy *int) error {
	if namespace == "" {
		return fmt.Errorf("namespace required")
	}
	_, err := s.db.Exec(
		`INSERT INTO namespace_admins (user_id, namespace, granted_by)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, namespace) DO NOTHING`,
		userID, namespace, grantedBy,
	)
	if err != nil {
		return fmt.Errorf("failed to add namespace admin: %w", err)
	}
	return nil
}

// Remove deletes the (user_id, namespace) pair. Returns nil even if the row
// didn't exist — idempotent.
func (s *PostgresNamespaceAdminStore) Remove(userID int, namespace string) error {
	_, err := s.db.Exec(
		`DELETE FROM namespace_admins WHERE user_id = $1 AND namespace = $2`,
		userID, namespace,
	)
	if err != nil {
		return fmt.Errorf("failed to remove namespace admin: %w", err)
	}
	return nil
}

// DeleteAllForNamespace removes every namespace-admin row for a namespace, used
// when a workspace/project is decommissioned. Returns the number removed.
func (s *PostgresNamespaceAdminStore) DeleteAllForNamespace(namespace string) (int64, error) {
	result, err := s.db.Exec(`DELETE FROM namespace_admins WHERE namespace = $1`, namespace)
	if err != nil {
		return 0, fmt.Errorf("failed to remove namespace admins for namespace: %w", err)
	}
	n, _ := result.RowsAffected()
	return n, nil
}

// IsAdminOf returns true if the user has a namespace_admins row for the
// given namespace. Hot path — called from PermissionChecker on every
// admin-role request.
func (s *PostgresNamespaceAdminStore) IsAdminOf(userID int, namespace string) (bool, error) {
	var exists bool
	err := s.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM namespace_admins WHERE user_id = $1 AND namespace = $2)`,
		userID, namespace,
	).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("failed to check namespace admin: %w", err)
	}
	return exists, nil
}

// ListByUser returns the namespace names this user is an admin of.
func (s *PostgresNamespaceAdminStore) ListByUser(userID int) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT namespace FROM namespace_admins WHERE user_id = $1 ORDER BY namespace`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list admin namespaces: %w", err)
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var ns string
		if err := rows.Scan(&ns); err != nil {
			return nil, err
		}
		out = append(out, ns)
	}
	return out, rows.Err()
}

// ListByNamespace returns all admins of a namespace, joined with username +
// email for display.
func (s *PostgresNamespaceAdminStore) ListByNamespace(namespace string) ([]NamespaceAdminWithUser, error) {
	rows, err := s.db.Query(
		`SELECT na.user_id, na.namespace, na.granted_by, na.created_at,
		        COALESCE(u.username, ''), u.email
		 FROM namespace_admins na
		 JOIN users u ON na.user_id = u.id
		 WHERE na.namespace = $1
		 ORDER BY u.email`,
		namespace,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list admins of namespace: %w", err)
	}
	defer rows.Close()

	var out []NamespaceAdminWithUser
	for rows.Next() {
		var a NamespaceAdminWithUser
		var grantedBy sql.NullInt64
		if err := rows.Scan(&a.UserID, &a.Namespace, &grantedBy, &a.CreatedAt, &a.Username, &a.Email); err != nil {
			return nil, err
		}
		if grantedBy.Valid {
			gb := int(grantedBy.Int64)
			a.GrantedBy = &gb
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountByUser returns how many namespaces this user admins. Used after a
// Remove to decide whether to demote the user back to collaborator.
func (s *PostgresNamespaceAdminStore) CountByUser(userID int) (int, error) {
	var n int
	err := s.db.QueryRow(
		`SELECT COUNT(*) FROM namespace_admins WHERE user_id = $1`,
		userID,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("failed to count admin namespaces: %w", err)
	}
	return n, nil
}
