package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/secrets"
)

// WorkspaceGroup is a shared git remote base — the DB/UI equivalent of the
// GIT_REMOTE_URL env provisioning. Every workspace created in the group mirrors
// to <base_url>/<namespace>.git using the group's shared credential, so an
// operator declares the base + token once and then adds namespaces to it.
type WorkspaceGroup struct {
	ID             int       `json:"id"`
	Name           string    `json:"name"`
	Transport      string    `json:"transport"` // "https" | "ssh"
	BaseURL        string    `json:"base_url"`
	Username       string    `json:"username"`
	Branch         string    `json:"branch"`
	KnownHosts     string    `json:"known_hosts,omitempty"`
	HasCredential  bool      `json:"has_credential"`
	WorkspaceCount int       `json:"workspace_count"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

// WorkspaceGroupInput carries the writable fields of a group. Credential (the
// shared PAT / SSH key) follows the same nil-means-unchanged rule as workspaces.
type WorkspaceGroupInput struct {
	Name       string
	Transport  string
	BaseURL    string
	Username   string
	Branch     string
	KnownHosts string
	Credential *string
}

const groupSelect = `
	SELECT g.id, g.name, g.transport, g.base_url, g.username, g.branch,
	       g.known_hosts, (g.credential_encrypted <> '') AS has_credential,
	       (SELECT COUNT(*) FROM workspaces w WHERE w.group_id = g.id),
	       g.created_at, g.updated_at
	FROM workspace_groups g`

func (s *PostgresWorkspaceStore) ListGroups() ([]WorkspaceGroup, error) {
	rows, err := s.db.Query(groupSelect + ` ORDER BY g.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]WorkspaceGroup, 0)
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *PostgresWorkspaceStore) GetGroup(id int) (*WorkspaceGroup, error) {
	return s.getGroup(groupSelect+` WHERE g.id = $1`, id)
}

func (s *PostgresWorkspaceStore) GetGroupByName(name string) (*WorkspaceGroup, error) {
	return s.getGroup(groupSelect+` WHERE g.name = $1`, name)
}

func (s *PostgresWorkspaceStore) getGroup(query string, args ...any) (*WorkspaceGroup, error) {
	g, err := scanGroup(s.db.QueryRow(query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

func (s *PostgresWorkspaceStore) CreateGroup(in WorkspaceGroupInput) (*WorkspaceGroup, error) {
	in = normalizeGroup(in)
	enc := ""
	if in.Credential != nil && *in.Credential != "" {
		var err error
		if enc, err = secrets.Encrypt([]byte(*in.Credential), s.key); err != nil {
			return nil, fmt.Errorf("encrypt group credential: %w", err)
		}
	}
	var id int
	err := s.db.QueryRow(
		`INSERT INTO workspace_groups
		   (name, transport, base_url, username, branch, known_hosts, credential_encrypted)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		in.Name, in.Transport, in.BaseURL, in.Username, in.Branch, in.KnownHosts, enc,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.GetGroup(id)
}

func (s *PostgresWorkspaceStore) UpdateGroup(id int, in WorkspaceGroupInput) (*WorkspaceGroup, error) {
	in = normalizeGroup(in)
	if in.Credential == nil {
		_, err := s.db.Exec(
			`UPDATE workspace_groups SET
			   name = $2, transport = $3, base_url = $4, username = $5,
			   branch = $6, known_hosts = $7, updated_at = now()
			 WHERE id = $1`,
			id, in.Name, in.Transport, in.BaseURL, in.Username, in.Branch, in.KnownHosts,
		)
		if err != nil {
			return nil, err
		}
		return s.GetGroup(id)
	}
	enc := ""
	if *in.Credential != "" {
		var err error
		if enc, err = secrets.Encrypt([]byte(*in.Credential), s.key); err != nil {
			return nil, fmt.Errorf("encrypt group credential: %w", err)
		}
	}
	_, err := s.db.Exec(
		`UPDATE workspace_groups SET
		   name = $2, transport = $3, base_url = $4, username = $5, branch = $6,
		   known_hosts = $7, credential_encrypted = $8, updated_at = now()
		 WHERE id = $1`,
		id, in.Name, in.Transport, in.BaseURL, in.Username, in.Branch, in.KnownHosts, enc,
	)
	if err != nil {
		return nil, err
	}
	return s.GetGroup(id)
}

// DeleteGroup removes a group. The workspaces.group_id FK is ON DELETE CASCADE,
// so its member workspaces (their mirror config only, not the notes) go with it.
func (s *PostgresWorkspaceStore) DeleteGroup(id int) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM workspace_groups WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// CreateInGroup adds a namespace to a group. The workspace inherits the group's
// transport/base/credential (the per-namespace repo is <base>/<namespace>.git),
// so only the namespace and enabled flag are stored on the row itself.
func (s *PostgresWorkspaceStore) CreateInGroup(groupID int, namespace string, gitEnabled bool) (*Workspace, error) {
	var id int
	err := s.db.QueryRow(
		`INSERT INTO workspaces (namespace, git_enabled, group_id)
		 VALUES ($1, $2, $3)
		 RETURNING id`,
		namespace, gitEnabled, groupID,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.Get(id)
}

func normalizeGroup(in WorkspaceGroupInput) WorkspaceGroupInput {
	if in.Transport = strings.ToLower(strings.TrimSpace(in.Transport)); in.Transport != "ssh" {
		in.Transport = "https"
	}
	if strings.TrimSpace(in.Username) == "" {
		in.Username = "oauth2"
	}
	if strings.TrimSpace(in.Branch) == "" {
		in.Branch = "main"
	}
	in.BaseURL = strings.TrimSpace(in.BaseURL)
	return in
}

func scanGroup(row rowScanner) (WorkspaceGroup, error) {
	var g WorkspaceGroup
	if err := row.Scan(
		&g.ID, &g.Name, &g.Transport, &g.BaseURL, &g.Username, &g.Branch,
		&g.KnownHosts, &g.HasCredential, &g.WorkspaceCount, &g.CreatedAt, &g.UpdatedAt,
	); err != nil {
		return WorkspaceGroup{}, err
	}
	return g, nil
}
