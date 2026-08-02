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
	ID            int    `json:"id"`
	Name          string `json:"name"`
	Transport     string `json:"transport"` // "https" | "ssh"
	BaseURL       string `json:"base_url"`
	Username      string `json:"username"`
	Branch        string `json:"branch"`
	KnownHosts    string `json:"known_hosts,omitempty"`
	HasCredential bool   `json:"has_credential"`
	// Source is 'ui' (superadmin-managed in the admin panel) or 'provisioned'
	// (reconciled on boot from operator config: the panel may only manage its
	// sub-projects, never edit or delete the group itself).
	Source         string    `json:"source"`
	WorkspaceCount int       `json:"workspace_count"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	// ImplicitNamespaces is populated by the handler (never stored/scanned): for
	// a provisioned group it lists existing namespaces that mirror under its base
	// via the env default but have no explicit workspace row.
	ImplicitNamespaces []string `json:"implicit_namespaces,omitempty"`
}

// IsProvisioned reports whether the group is operator-owned (env-reconciled) and
// therefore immutable from the admin panel except for its sub-projects.
func (g WorkspaceGroup) IsProvisioned() bool { return g.Source == "provisioned" }

// ProvisionedGroupSpec is an operator-declared group reconciled on boot from
// environment config (GIT_REMOTE_URL + token). Credential is the plaintext PAT
// or SSH key; it is sealed at rest like any other group credential so grouped
// members resolve through the exact same path as UI groups.
type ProvisionedGroupSpec struct {
	Name       string
	Transport  string
	BaseURL    string
	Username   string
	Branch     string
	Credential string
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
	       g.known_hosts, (g.credential_encrypted <> '') AS has_credential, g.source,
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
	in.Transport, in.Username, in.Branch = normalizeGitDefaults(in.Transport, in.Username, in.Branch)
	in.BaseURL = strings.TrimSpace(in.BaseURL)
	return in
}

func scanGroup(row rowScanner) (WorkspaceGroup, error) {
	var g WorkspaceGroup
	if err := row.Scan(
		&g.ID, &g.Name, &g.Transport, &g.BaseURL, &g.Username, &g.Branch,
		&g.KnownHosts, &g.HasCredential, &g.Source, &g.WorkspaceCount, &g.CreatedAt, &g.UpdatedAt,
	); err != nil {
		return WorkspaceGroup{}, err
	}
	return g, nil
}

// EnsureProvisionedGroup upserts a source='provisioned' group by name, reconciled
// on boot from operator config. The base/transport/username/branch are refreshed
// every call so editing the deployment values and restarting updates the group;
// the credential is refreshed only when a non-empty one is supplied (so a missing
// token at boot never wipes a previously-sealed one). A name that already exists
// as a 'ui' group is taken over as provisioned — provisioned config wins.
func (s *PostgresWorkspaceStore) EnsureProvisionedGroup(spec ProvisionedGroupSpec) (*WorkspaceGroup, error) {
	transport, username, branch := normalizeGitDefaults(spec.Transport, spec.Username, spec.Branch)
	baseURL := strings.TrimRight(strings.TrimSpace(spec.BaseURL), "/")
	enc := ""
	if spec.Credential != "" {
		var err error
		if enc, err = secrets.Encrypt([]byte(spec.Credential), s.key); err != nil {
			return nil, fmt.Errorf("encrypt provisioned group credential: %w", err)
		}
	}
	// credential_encrypted is only overwritten when a new token is supplied
	// (COALESCE keeps the existing one when EXCLUDED is '').
	var id int
	err := s.db.QueryRow(
		`INSERT INTO workspace_groups
		   (name, transport, base_url, username, branch, credential_encrypted, source)
		 VALUES ($1, $2, $3, $4, $5, $6, 'provisioned')
		 ON CONFLICT (name) DO UPDATE SET
		   transport = EXCLUDED.transport,
		   base_url  = EXCLUDED.base_url,
		   username  = EXCLUDED.username,
		   branch    = EXCLUDED.branch,
		   credential_encrypted = CASE WHEN EXCLUDED.credential_encrypted <> ''
		                               THEN EXCLUDED.credential_encrypted
		                               ELSE workspace_groups.credential_encrypted END,
		   source    = 'provisioned',
		   updated_at = now()
		 RETURNING id`,
		strings.TrimSpace(spec.Name), transport, baseURL, username, branch, enc,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	// Keep a single provisioned group: if the operator renamed it
	// (GIT_PROVISIONED_GROUP_NAME) the stale row would otherwise linger as an
	// undeletable orphan, so drop any other provisioned group here.
	if _, err := s.db.Exec(
		`DELETE FROM workspace_groups WHERE source = 'provisioned' AND id <> $1`, id,
	); err != nil {
		return nil, err
	}
	return s.GetGroup(id)
}
