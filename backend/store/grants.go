package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"
)

// Grant represents a row in the access_grants table.
type Grant struct {
	ID         int
	UserID     int
	Namespace  string
	Path       string // "/" = full namespace, "/subdir" = scoped
	Permission string // "read" or "write"
	GrantedBy  *int
	CreatedAt  time.Time
}

// GrantWithUser is a grant with the associated username for display.
type GrantWithUser struct {
	Grant
	Username string
}

// GrantStore defines access grant operations.
type GrantStore interface {
	CreateGrant(userID int, namespace, path, permission string, grantedBy *int) (*Grant, error)
	UpdateGrantPermission(id int, permission string) error
	DeleteGrant(id int) error
	DeleteGrantsForNamespace(namespace string) (int64, error)
	GetGrant(id int) (*Grant, error)
	GetGrantsForUser(userID int) ([]Grant, error)
	GetGrantsForNamespace(namespace string) ([]Grant, error)
	GetGrantsForPath(namespace, path string) ([]GrantWithUser, error)
	ListAllGrants() ([]GrantWithUser, error)
	CheckAccess(userID int, namespace, path, requiredPermission string) bool
	GetAccessibleNamespaces(userID int) ([]string, error)
}

// PostgresGrantStore implements GrantStore against a Postgres database.
type PostgresGrantStore struct {
	db *DB
}

// NewPostgresGrantStore creates a new PostgresGrantStore.
func NewPostgresGrantStore(db *DB) *PostgresGrantStore {
	return &PostgresGrantStore{db: db}
}

func (s *PostgresGrantStore) CreateGrant(userID int, namespace, path, permission string, grantedBy *int) (*Grant, error) {
	if path == "" {
		path = "/"
	}
	if permission == "" {
		permission = "write"
	}
	if permission != "read" && permission != "write" {
		return nil, fmt.Errorf("permission must be read or write")
	}

	var g Grant
	err := s.db.QueryRow(
		`INSERT INTO access_grants (user_id, namespace, path, permission, granted_by)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id, user_id, namespace, path, permission, granted_by, created_at`,
		userID, namespace, path, permission, grantedBy,
	).Scan(&g.ID, &g.UserID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("failed to create grant: %w", err)
	}
	return &g, nil
}

func (s *PostgresGrantStore) UpdateGrantPermission(id int, permission string) error {
	if permission != "read" && permission != "write" {
		return fmt.Errorf("permission must be read or write")
	}
	result, err := s.db.Exec(`UPDATE access_grants SET permission = $1 WHERE id = $2`, permission, id)
	if err != nil {
		return fmt.Errorf("failed to update grant: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("grant not found")
	}
	return nil
}

func (s *PostgresGrantStore) GetGrantsForPath(namespace, path string) ([]GrantWithUser, error) {
	rows, err := s.db.Query(
		`SELECT g.id, g.user_id, g.namespace, g.path, g.permission, g.granted_by, g.created_at, u.username
		 FROM access_grants g JOIN users u ON g.user_id = u.id
		 WHERE g.namespace = $1 AND g.path = $2
		 ORDER BY u.username`,
		namespace, path,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to query grants for path: %w", err)
	}
	defer rows.Close()

	var grants []GrantWithUser
	for rows.Next() {
		var g GrantWithUser
		if err := rows.Scan(&g.ID, &g.UserID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt, &g.Username); err != nil {
			return nil, fmt.Errorf("failed to scan grant: %w", err)
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

// GetGrant returns a single grant by id, or (nil, nil) if not found.
func (s *PostgresGrantStore) GetGrant(id int) (*Grant, error) {
	row := s.db.QueryRow(
		`SELECT id, user_id, namespace, path, permission, granted_by, created_at
		 FROM access_grants WHERE id = $1`, id,
	)
	g, err := ScanGrant(row)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch grant: %w", err)
	}
	return g, nil
}

func (s *PostgresGrantStore) DeleteGrant(id int) error {
	result, err := s.db.Exec(`DELETE FROM access_grants WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("failed to delete grant: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("grant not found")
	}
	return nil
}

// DeleteGrantsForNamespace removes every access grant on a namespace, used when
// a workspace/project is decommissioned so no orphaned grants linger. Returns
// the number of grants removed.
func (s *PostgresGrantStore) DeleteGrantsForNamespace(namespace string) (int64, error) {
	result, err := s.db.Exec(`DELETE FROM access_grants WHERE namespace = $1`, namespace)
	if err != nil {
		return 0, fmt.Errorf("failed to delete grants for namespace: %w", err)
	}
	n, _ := result.RowsAffected()
	return n, nil
}

func (s *PostgresGrantStore) GetGrantsForUser(userID int) ([]Grant, error) {
	return s.queryGrants(
		`SELECT id, user_id, namespace, path, permission, granted_by, created_at
		 FROM access_grants WHERE user_id = $1 ORDER BY namespace, path`, userID,
	)
}

func (s *PostgresGrantStore) GetGrantsForNamespace(namespace string) ([]Grant, error) {
	return s.queryGrants(
		`SELECT id, user_id, namespace, path, permission, granted_by, created_at
		 FROM access_grants WHERE namespace = $1 ORDER BY user_id, path`, namespace,
	)
}

func (s *PostgresGrantStore) ListAllGrants() ([]GrantWithUser, error) {
	rows, err := s.db.Query(
		`SELECT g.id, g.user_id, g.namespace, g.path, g.permission, g.granted_by, g.created_at, u.username
		 FROM access_grants g JOIN users u ON g.user_id = u.id
		 ORDER BY u.username, g.namespace, g.path`,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to list all grants: %w", err)
	}
	defer rows.Close()

	var grants []GrantWithUser
	for rows.Next() {
		var g GrantWithUser
		if err := rows.Scan(&g.ID, &g.UserID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt, &g.Username); err != nil {
			return nil, fmt.Errorf("failed to scan grant: %w", err)
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

func (s *PostgresGrantStore) queryGrants(query string, args ...interface{}) ([]Grant, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query grants: %w", err)
	}
	defer rows.Close()

	var grants []Grant
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.ID, &g.UserID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt); err != nil {
			return nil, fmt.Errorf("failed to scan grant: %w", err)
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

// CheckAccess returns true if the user has the required permission for the
// given namespace and path.
//
// Access rules:
//   - A grant on "/" covers the entire namespace.
//   - A grant on "/subdir" covers that directory and everything below it.
//   - "write" permission implies "read".
//   - If no matching grant exists, access is denied.
func (s *PostgresGrantStore) CheckAccess(userID int, namespace, path, requiredPermission string) bool {
	// Normalize path: ensure it starts with /
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	grants, err := s.GetGrantsForUser(userID)
	if err != nil {
		return false
	}

	for _, g := range grants {
		if g.Namespace != namespace {
			continue
		}

		// Check if the grant's path covers the requested path
		grantPath := g.Path
		if !strings.HasPrefix(grantPath, "/") {
			grantPath = "/" + grantPath
		}

		if !pathCovers(grantPath, path) {
			continue
		}

		// Check permission level
		if requiredPermission == "read" {
			// Both "read" and "write" grants satisfy a "read" requirement
			return true
		}
		if requiredPermission == "write" && g.Permission == "write" {
			return true
		}
	}
	return false
}

// GetAccessibleNamespaces returns the list of namespace names the user has
// any grant for.
func (s *PostgresGrantStore) GetAccessibleNamespaces(userID int) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT namespace FROM access_grants WHERE user_id = $1 ORDER BY namespace`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var nsList []string
	for rows.Next() {
		var ns string
		if err := rows.Scan(&ns); err != nil {
			return nil, err
		}
		nsList = append(nsList, ns)
	}
	return nsList, rows.Err()
}

// PathDepth returns the number of non-empty segments in a path:
//
//	"/"            → 0
//	"/foo"         → 1
//	"/foo/bar"     → 2
//	"/foo/bar/baz" → 3
//
// Used by the GRANT_MAX_DEPTH check at grant-creation time. Leading
// and trailing slashes are ignored; "//" collapses are treated as a
// single separator (so accidentally-malformed paths don't game the
// limit).
func PathDepth(p string) int {
	s := strings.Trim(p, "/")
	if s == "" {
		return 0
	}
	depth := 1
	prev := byte(0)
	for i := 0; i < len(s); i++ {
		if s[i] == '/' && prev != '/' {
			depth++
		}
		prev = s[i]
	}
	return depth
}

// pathCovers returns true if grantPath covers requestPath.
// "/" covers everything. "/foo" covers "/foo", "/foo/bar", "/foo/bar/baz".
func pathCovers(grantPath, requestPath string) bool {
	if grantPath == "/" {
		return true
	}
	// Exact match
	if requestPath == grantPath {
		return true
	}
	// requestPath is under grantPath (e.g., grant="/docs", request="/docs/readme.md")
	if strings.HasPrefix(requestPath, grantPath+"/") {
		return true
	}
	return false
}

// ScanGrant scans a single grant from a query row.
func ScanGrant(row *sql.Row) (*Grant, error) {
	var g Grant
	err := row.Scan(&g.ID, &g.UserID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}
