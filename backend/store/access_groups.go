package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/lib/pq"
)

// AccessGroup is a named, superadmin-managed set used for role-based access.
// Its members are mdnest users and/or IdP (OIDC) group IDs, and it carries
// namespace grants (access_group_grants) that mirror per-user access_grants.
type AccessGroup struct {
	ID          int
	Name        string
	Description string
	CreatedAt   time.Time
}

// GroupMember is one membership row: exactly one of UserID / OIDCGroup is set.
type GroupMember struct {
	GroupID   int
	UserID    *int    // set for a direct mdnest-user member
	OIDCGroup *string // set for an IdP group ID member
	OIDCLabel string  // optional human label for an OIDC group ID (display only)
	CreatedAt time.Time
	// Username is filled for display when the member is a direct user.
	Username string
}

// GroupGrant is a namespace grant attached to a group (mirrors Grant).
type GroupGrant struct {
	ID         int
	GroupID    int
	Namespace  string
	Path       string
	Permission string
	GrantedBy  *int
	CreatedAt  time.Time
}

// GroupStore defines role-based "Groups" access operations.
type GroupStore interface {
	CreateGroup(name, description string) (*AccessGroup, error)
	UpdateGroup(id int, name, description string) error
	DeleteGroup(id int) error
	GetGroup(id int) (*AccessGroup, error)
	ListGroups() ([]AccessGroup, error)

	AddUserMember(groupID, userID int) error
	AddOIDCMember(groupID int, oidcGroup, label string) error
	RemoveUserMember(groupID, userID int) error
	RemoveOIDCMember(groupID int, oidcGroup string) error
	ListMembers(groupID int) ([]GroupMember, error)

	CreateGroupGrant(groupID int, namespace, path, permission string, grantedBy *int) (*GroupGrant, error)
	UpdateGroupGrantPermission(id int, permission string) error
	DeleteGroupGrant(id int) error
	ListGrantsForGroup(groupID int) ([]GroupGrant, error)
	DeleteGroupGrantsForNamespace(namespace string) (int64, error)

	// CheckGroupAccess reports whether the user — via any group they belong to
	// (as a direct member or through one of their OIDC group IDs) — has the
	// required permission on namespace/path.
	CheckGroupAccess(userID int, oidcGroups []string, namespace, path, requiredPermission string) bool
	// GetAccessibleNamespacesForGroups returns the namespaces reachable through
	// the user's group memberships.
	GetAccessibleNamespacesForGroups(userID int, oidcGroups []string) ([]string, error)
	// MemberGroupGrants returns the grants a user inherits, within a single
	// namespace, from the groups they belong to (as a direct member or through
	// one of their OIDC group IDs).
	MemberGroupGrants(userID int, oidcGroups []string, namespace string) ([]GroupGrant, error)
}

// PostgresGroupStore implements GroupStore against Postgres.
type PostgresGroupStore struct {
	db *DB
}

// NewPostgresGroupStore creates a new PostgresGroupStore.
func NewPostgresGroupStore(db *DB) *PostgresGroupStore {
	return &PostgresGroupStore{db: db}
}

func (s *PostgresGroupStore) CreateGroup(name, description string) (*AccessGroup, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("group name is required")
	}
	g := &AccessGroup{}
	err := s.db.QueryRow(
		`INSERT INTO access_groups (name, description) VALUES ($1, $2)
		 RETURNING id, name, description, created_at`,
		name, description,
	).Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt)
	if err != nil {
		return nil, err
	}
	return g, nil
}

func (s *PostgresGroupStore) UpdateGroup(id int, name, description string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("group name is required")
	}
	_, err := s.db.Exec(
		`UPDATE access_groups SET name = $1, description = $2 WHERE id = $3`,
		name, description, id,
	)
	return err
}

func (s *PostgresGroupStore) DeleteGroup(id int) error {
	_, err := s.db.Exec(`DELETE FROM access_groups WHERE id = $1`, id)
	return err
}

func (s *PostgresGroupStore) GetGroup(id int) (*AccessGroup, error) {
	g := &AccessGroup{}
	err := s.db.QueryRow(
		`SELECT id, name, description, created_at FROM access_groups WHERE id = $1`, id,
	).Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return g, nil
}

func (s *PostgresGroupStore) ListGroups() ([]AccessGroup, error) {
	rows, err := s.db.Query(
		`SELECT id, name, description, created_at FROM access_groups ORDER BY name`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var groups []AccessGroup
	for rows.Next() {
		var g AccessGroup
		if err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt); err != nil {
			return nil, err
		}
		groups = append(groups, g)
	}
	return groups, rows.Err()
}

func (s *PostgresGroupStore) AddUserMember(groupID, userID int) error {
	_, err := s.db.Exec(
		`INSERT INTO access_group_members (group_id, user_id) VALUES ($1, $2)
		 ON CONFLICT DO NOTHING`,
		groupID, userID,
	)
	return err
}

func (s *PostgresGroupStore) AddOIDCMember(groupID int, oidcGroup, label string) error {
	oidcGroup = strings.TrimSpace(oidcGroup)
	if oidcGroup == "" {
		return fmt.Errorf("oidc group id is required")
	}
	_, err := s.db.Exec(
		`INSERT INTO access_group_members (group_id, oidc_group, oidc_group_label) VALUES ($1, $2, $3)
		 ON CONFLICT (group_id, oidc_group) WHERE oidc_group IS NOT NULL DO UPDATE SET oidc_group_label = EXCLUDED.oidc_group_label`,
		groupID, oidcGroup, strings.TrimSpace(label),
	)
	return err
}

func (s *PostgresGroupStore) RemoveUserMember(groupID, userID int) error {
	_, err := s.db.Exec(
		`DELETE FROM access_group_members WHERE group_id = $1 AND user_id = $2`,
		groupID, userID,
	)
	return err
}

func (s *PostgresGroupStore) RemoveOIDCMember(groupID int, oidcGroup string) error {
	_, err := s.db.Exec(
		`DELETE FROM access_group_members WHERE group_id = $1 AND oidc_group = $2`,
		groupID, oidcGroup,
	)
	return err
}

func (s *PostgresGroupStore) ListMembers(groupID int) ([]GroupMember, error) {
	rows, err := s.db.Query(
		`SELECT m.group_id, m.user_id, m.oidc_group, m.oidc_group_label, m.created_at, COALESCE(u.username, '')
		 FROM access_group_members m
		 LEFT JOIN users u ON u.id = m.user_id
		 WHERE m.group_id = $1
		 ORDER BY m.oidc_group NULLS FIRST, u.username`,
		groupID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var members []GroupMember
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.GroupID, &m.UserID, &m.OIDCGroup, &m.OIDCLabel, &m.CreatedAt, &m.Username); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

func (s *PostgresGroupStore) CreateGroupGrant(groupID int, namespace, path, permission string, grantedBy *int) (*GroupGrant, error) {
	if path == "" {
		path = "/"
	}
	if permission == "" {
		permission = "write"
	}
	if permission != "read" && permission != "write" {
		return nil, fmt.Errorf("permission must be read or write")
	}
	g := &GroupGrant{}
	err := s.db.QueryRow(
		`INSERT INTO access_group_grants (group_id, namespace, path, permission, granted_by)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (group_id, namespace, path) DO UPDATE SET permission = EXCLUDED.permission
		 RETURNING id, group_id, namespace, path, permission, granted_by, created_at`,
		groupID, namespace, path, permission, grantedBy,
	).Scan(&g.ID, &g.GroupID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt)
	if err != nil {
		return nil, err
	}
	return g, nil
}

func (s *PostgresGroupStore) UpdateGroupGrantPermission(id int, permission string) error {
	if permission != "read" && permission != "write" {
		return fmt.Errorf("permission must be read or write")
	}
	_, err := s.db.Exec(`UPDATE access_group_grants SET permission = $1 WHERE id = $2`, permission, id)
	return err
}

func (s *PostgresGroupStore) DeleteGroupGrant(id int) error {
	_, err := s.db.Exec(`DELETE FROM access_group_grants WHERE id = $1`, id)
	return err
}

func (s *PostgresGroupStore) ListGrantsForGroup(groupID int) ([]GroupGrant, error) {
	rows, err := s.db.Query(
		`SELECT id, group_id, namespace, path, permission, granted_by, created_at
		 FROM access_group_grants WHERE group_id = $1 ORDER BY namespace, path`,
		groupID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var grants []GroupGrant
	for rows.Next() {
		var g GroupGrant
		if err := rows.Scan(&g.ID, &g.GroupID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt); err != nil {
			return nil, err
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

func (s *PostgresGroupStore) DeleteGroupGrantsForNamespace(namespace string) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM access_group_grants WHERE namespace = $1`, namespace)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// memberGroupGrants returns all group grants in a namespace for the groups the
// user belongs to (directly or via an OIDC group ID).
// MemberGroupGrants returns the grants a user inherits, within namespace, from
// the groups they belong to (as a direct member or via one of their OIDC group
// IDs).
func (s *PostgresGroupStore) MemberGroupGrants(userID int, oidcGroups []string, namespace string) ([]GroupGrant, error) {
	rows, err := s.db.Query(
		`SELECT gg.id, gg.group_id, gg.namespace, gg.path, gg.permission, gg.granted_by, gg.created_at
		 FROM access_group_grants gg
		 WHERE gg.namespace = $1
		   AND gg.group_id IN (
		     SELECT group_id FROM access_group_members
		     WHERE user_id = $2 OR oidc_group = ANY($3)
		   )`,
		namespace, userID, pq.Array(oidcGroups),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var grants []GroupGrant
	for rows.Next() {
		var g GroupGrant
		if err := rows.Scan(&g.ID, &g.GroupID, &g.Namespace, &g.Path, &g.Permission, &g.GrantedBy, &g.CreatedAt); err != nil {
			return nil, err
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

func (s *PostgresGroupStore) CheckGroupAccess(userID int, oidcGroups []string, namespace, path, requiredPermission string) bool {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	grants, err := s.MemberGroupGrants(userID, oidcGroups, namespace)
	if err != nil {
		return false
	}
	for _, g := range grants {
		grantPath := g.Path
		if !strings.HasPrefix(grantPath, "/") {
			grantPath = "/" + grantPath
		}
		if !pathCovers(grantPath, path) {
			continue
		}
		if requiredPermission == "read" {
			return true
		}
		if requiredPermission == "write" && g.Permission == "write" {
			return true
		}
	}
	return false
}

func (s *PostgresGroupStore) GetAccessibleNamespacesForGroups(userID int, oidcGroups []string) ([]string, error) {
	rows, err := s.db.Query(
		`SELECT DISTINCT gg.namespace
		 FROM access_group_grants gg
		 WHERE gg.group_id IN (
		   SELECT group_id FROM access_group_members
		   WHERE user_id = $1 OR oidc_group = ANY($2)
		 )
		 ORDER BY gg.namespace`,
		userID, pq.Array(oidcGroups),
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
