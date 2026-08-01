package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/secrets"
)

// Workspace is the per-namespace git remote configuration exposed to API
// clients. It carries only metadata — never the stored credential. HasCredential
// reports whether a PAT / SSH key is on file so the UI can show "configured"
// without ever reading the secret back.
type Workspace struct {
	ID            int    `json:"id"`
	Namespace     string `json:"namespace"`
	OwnerID       *int   `json:"owner_id,omitempty"`    // nil = shared/team workspace
	OwnerEmail    string `json:"owner_email,omitempty"` // resolved via join, for admin UIs
	IsPersonal    bool   `json:"is_personal"`
	GitEnabled    bool   `json:"git_enabled"`
	Transport     string `json:"transport"` // "https" | "ssh"
	RemoteURL     string `json:"remote_url"`
	Username      string `json:"username"`
	Branch        string `json:"branch"`
	KnownHosts    string `json:"known_hosts,omitempty"` // SSH host keys (public), not a secret
	HasCredential bool   `json:"has_credential"`
	GroupID       *int   `json:"group_id,omitempty"`   // set when the workspace belongs to a group
	GroupName     string `json:"group_name,omitempty"` // resolved via join, for admin UIs
	// LastSyncError is the error from the writer's most recent mirror sync (''
	// when the last sync succeeded); LastSyncAt is when it was recorded. Surfaced
	// in the UI so a failing mirror is visible instead of a silently-empty ns.
	LastSyncError string     `json:"last_sync_error,omitempty"`
	LastSyncAt    *time.Time `json:"last_sync_at,omitempty"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// WorkspaceRemote is the decrypted per-namespace remote used by the git backend
// resolver. It is never serialised to a client — only handed to the committer
// to build a push. Credential is the plaintext PAT (https) or SSH private key.
type WorkspaceRemote struct {
	Namespace  string
	Transport  string
	RemoteURL  string
	Username   string
	Branch     string
	KnownHosts string
	Credential string
}

// WorkspaceInput carries the writable fields of a workspace. Credential is the
// plaintext PAT or SSH private key: nil leaves the stored credential unchanged
// (on update) or stores none (on create); a non-nil pointer replaces it.
type WorkspaceInput struct {
	Namespace  string
	OwnerID    *int
	IsPersonal bool
	GitEnabled bool
	Transport  string
	RemoteURL  string
	Username   string
	Branch     string
	KnownHosts string
	Credential *string
}

// WorkspaceStore persists per-workspace git remote configuration in the
// workspaces table (multi mode only). Credentials are sealed at rest with
// AES-256-GCM (see backend/secrets); the encryption key is derived once from an
// operator secret at construction.
type WorkspaceStore interface {
	List() ([]Workspace, error)
	Get(id int) (*Workspace, error)
	GetByNamespace(ns string) (*Workspace, error)
	GetPersonalByOwner(ownerID int) (*Workspace, error)
	Create(in WorkspaceInput) (*Workspace, error)
	Update(id int, in WorkspaceInput) (*Workspace, error)
	Delete(id int) (bool, error)
	// RemoteForNamespace returns the decrypted, git-enabled remote for a
	// namespace, or (nil, nil) when the namespace has no configured override.
	RemoteForNamespace(ns string) (*WorkspaceRemote, error)
	// SetSyncStatus records the outcome of the writer's last mirror sync for a
	// namespace (syncErr == '' clears the error). A no-op for namespaces with no
	// workspace row (e.g. the coarse env-default mirror).
	SetSyncStatus(ns, syncErr string) error
	// PersonalNamespaces returns the namespaces of all personal workspaces, so
	// the management plane (admin grant / namespace-admin UIs) can exclude them:
	// personal namespaces are self-managed by their owner and never administered
	// by others.
	PersonalNamespaces() ([]string, error)

	// --- workspace groups: a shared git remote base (one repo per namespace),
	// the DB/UI equivalent of the GIT_REMOTE_URL env provisioning. Workspaces
	// created in a group inherit its transport/base/credentials; their per-ns
	// remote is <base>/<namespace>.git.
	ListGroups() ([]WorkspaceGroup, error)
	GetGroup(id int) (*WorkspaceGroup, error)
	GetGroupByName(name string) (*WorkspaceGroup, error)
	CreateGroup(in WorkspaceGroupInput) (*WorkspaceGroup, error)
	UpdateGroup(id int, in WorkspaceGroupInput) (*WorkspaceGroup, error)
	DeleteGroup(id int) (bool, error)
	// EnsureProvisionedGroup upserts an operator-declared group (source =
	// 'provisioned'), reconciled on boot from environment config.
	EnsureProvisionedGroup(spec ProvisionedGroupSpec) (*WorkspaceGroup, error)
	// CreateInGroup adds a namespace to a group; it inherits the group's remote.
	CreateInGroup(groupID int, namespace string, gitEnabled bool) (*Workspace, error)
}

// PostgresWorkspaceStore is the Postgres-backed WorkspaceStore.
type PostgresWorkspaceStore struct {
	db  *DB
	key [32]byte
}

// NewPostgresWorkspaceStore builds a workspace store whose credentials are
// sealed with a key derived from secret (SHA-256 → AES-256).
func NewPostgresWorkspaceStore(db *DB, secret string) *PostgresWorkspaceStore {
	return &PostgresWorkspaceStore{db: db, key: secrets.DeriveKey(secret)}
}

const workspaceSelect = `
	SELECT w.id, w.namespace, w.owner_id, COALESCE(u.email, ''), w.is_personal,
	       w.git_enabled, w.transport, w.remote_url, w.username, w.branch,
	       w.known_hosts, (w.credential_encrypted <> '') AS has_credential,
	       w.group_id, COALESCE(g.name, ''),
	       w.last_sync_error, w.last_sync_at,
	       w.created_at, w.updated_at
	FROM workspaces w
	LEFT JOIN users u ON u.id = w.owner_id
	LEFT JOIN workspace_groups g ON g.id = w.group_id`

func (s *PostgresWorkspaceStore) List() ([]Workspace, error) {
	rows, err := s.db.Query(workspaceSelect + ` ORDER BY w.namespace`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]Workspace, 0)
	for rows.Next() {
		w, err := scanWorkspace(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

func (s *PostgresWorkspaceStore) Get(id int) (*Workspace, error) {
	return s.getOne(workspaceSelect+` WHERE w.id = $1`, id)
}

func (s *PostgresWorkspaceStore) GetByNamespace(ns string) (*Workspace, error) {
	return s.getOne(workspaceSelect+` WHERE w.namespace = $1`, ns)
}

func (s *PostgresWorkspaceStore) GetPersonalByOwner(ownerID int) (*Workspace, error) {
	return s.getOne(workspaceSelect+` WHERE w.owner_id = $1 AND w.is_personal`, ownerID)
}

func (s *PostgresWorkspaceStore) getOne(query string, args ...any) (*Workspace, error) {
	w, err := scanWorkspace(s.db.QueryRow(query, args...))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &w, nil
}

func (s *PostgresWorkspaceStore) Create(in WorkspaceInput) (*Workspace, error) {
	in = normalizeInput(in)
	enc := ""
	if in.Credential != nil && *in.Credential != "" {
		var err error
		if enc, err = secrets.Encrypt([]byte(*in.Credential), s.key); err != nil {
			return nil, fmt.Errorf("encrypt credential: %w", err)
		}
	}
	var id int
	err := s.db.QueryRow(
		`INSERT INTO workspaces
		   (namespace, owner_id, is_personal, git_enabled, transport,
		    remote_url, username, branch, known_hosts, credential_encrypted)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		 RETURNING id`,
		in.Namespace, in.OwnerID, in.IsPersonal, in.GitEnabled, in.Transport,
		in.RemoteURL, in.Username, in.Branch, in.KnownHosts, enc,
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.Get(id)
}

func (s *PostgresWorkspaceStore) Update(id int, in WorkspaceInput) (*Workspace, error) {
	in = normalizeInput(in)
	// Credential is updated only when a new plaintext value is supplied, so an
	// edit that leaves the field blank keeps the stored secret.
	if in.Credential == nil {
		_, err := s.db.Exec(
			`UPDATE workspaces SET
			   git_enabled = $2, transport = $3, remote_url = $4, username = $5,
			   branch = $6, known_hosts = $7, updated_at = now()
			 WHERE id = $1`,
			id, in.GitEnabled, in.Transport, in.RemoteURL, in.Username,
			in.Branch, in.KnownHosts,
		)
		if err != nil {
			return nil, err
		}
		return s.Get(id)
	}
	enc := ""
	if *in.Credential != "" {
		var err error
		if enc, err = secrets.Encrypt([]byte(*in.Credential), s.key); err != nil {
			return nil, fmt.Errorf("encrypt credential: %w", err)
		}
	}
	_, err := s.db.Exec(
		`UPDATE workspaces SET
		   git_enabled = $2, transport = $3, remote_url = $4, username = $5,
		   branch = $6, known_hosts = $7, credential_encrypted = $8, updated_at = now()
		 WHERE id = $1`,
		id, in.GitEnabled, in.Transport, in.RemoteURL, in.Username,
		in.Branch, in.KnownHosts, enc,
	)
	if err != nil {
		return nil, err
	}
	return s.Get(id)
}

func (s *PostgresWorkspaceStore) Delete(id int) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM workspaces WHERE id = $1`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// PersonalNamespaces returns the namespaces of all personal workspaces.
func (s *PostgresWorkspaceStore) PersonalNamespaces() ([]string, error) {
	rows, err := s.db.Query(`SELECT namespace FROM workspaces WHERE is_personal`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var ns string
		if err := rows.Scan(&ns); err != nil {
			return nil, err
		}
		out = append(out, ns)
	}
	return out, rows.Err()
}

// SetSyncStatus records the outcome of the writer's last mirror sync for a
// namespace. syncErr is ” on success. It targets the standalone workspace row
// by namespace; grouped members are keyed by their own namespace too, so both
// resolve. Namespaces with no row (the coarse env-default mirror) are a no-op.
func (s *PostgresWorkspaceStore) SetSyncStatus(ns, syncErr string) error {
	_, err := s.db.Exec(
		`UPDATE workspaces SET last_sync_error = $2, last_sync_at = now() WHERE namespace = $1`,
		ns, syncErr)
	return err
}

func (s *PostgresWorkspaceStore) RemoteForNamespace(ns string) (*WorkspaceRemote, error) {
	var (
		r           WorkspaceRemote
		enc         string
		gitEnabled  bool
		groupID     sql.NullInt64
		gTransport  sql.NullString
		gBaseURL    sql.NullString
		gUsername   sql.NullString
		gBranch     sql.NullString
		gKnownHosts sql.NullString
		gEnc        sql.NullString
	)
	r.Namespace = ns
	err := s.db.QueryRow(
		`SELECT w.git_enabled, w.group_id, w.transport, w.remote_url, w.username,
		        w.branch, w.known_hosts, w.credential_encrypted,
		        g.transport, g.base_url, g.username, g.branch, g.known_hosts,
		        g.credential_encrypted
		 FROM workspaces w
		 LEFT JOIN workspace_groups g ON g.id = w.group_id
		 WHERE w.namespace = $1`, ns,
	).Scan(&gitEnabled, &groupID, &r.Transport, &r.RemoteURL, &r.Username,
		&r.Branch, &r.KnownHosts, &enc,
		&gTransport, &gBaseURL, &gUsername, &gBranch, &gKnownHosts, &gEnc)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !gitEnabled {
		return nil, nil
	}
	if groupID.Valid {
		// Grouped workspace: inherit the group's transport/credential; the
		// per-namespace repo is <base>/<namespace>.git.
		r.Transport = gTransport.String
		r.RemoteURL = groupRepoURL(gBaseURL.String, ns)
		r.Username = gUsername.String
		r.Branch = gBranch.String
		r.KnownHosts = gKnownHosts.String
		enc = gEnc.String
	} else if r.RemoteURL == "" {
		// Standalone workspace with no remote configured.
		return nil, nil
	}
	if enc != "" {
		cred, err := secrets.Decrypt(enc, s.key)
		if err != nil {
			return nil, fmt.Errorf("decrypt credential for %q: %w", ns, err)
		}
		r.Credential = string(cred)
	}
	return &r, nil
}

// groupRepoURL derives a namespace's repository URL from a group's base:
// <base>/<namespace>.git. The string join works for both HTTPS URLs and
// scp-like SSH bases (git@host:group -> git@host:group/<ns>.git).
func groupRepoURL(base, ns string) string {
	return strings.TrimRight(strings.TrimSpace(base), "/") + "/" + ns + ".git"
}

// normalizeGitDefaults applies the shared git-field defaults: transport is
// https unless explicitly ssh, username defaults to oauth2, branch to main.
func normalizeGitDefaults(transport, username, branch string) (string, string, string) {
	if transport = strings.ToLower(strings.TrimSpace(transport)); transport != "ssh" {
		transport = "https"
	}
	if strings.TrimSpace(username) == "" {
		username = "oauth2"
	}
	if strings.TrimSpace(branch) == "" {
		branch = "main"
	}
	return transport, username, branch
}

// normalizeInput applies the column defaults so callers may leave transport /
// username / branch blank.
func normalizeInput(in WorkspaceInput) WorkspaceInput {
	in.Transport, in.Username, in.Branch = normalizeGitDefaults(in.Transport, in.Username, in.Branch)
	return in
}

// scanWorkspace reads a workspace row (rowScanner is declared in tokens.go and
// satisfied by both *sql.Row and *sql.Rows).
func scanWorkspace(row rowScanner) (Workspace, error) {
	var w Workspace
	var ownerID sql.NullInt64
	var groupID sql.NullInt64
	var lastSyncAt sql.NullTime
	if err := row.Scan(
		&w.ID, &w.Namespace, &ownerID, &w.OwnerEmail, &w.IsPersonal,
		&w.GitEnabled, &w.Transport, &w.RemoteURL, &w.Username, &w.Branch,
		&w.KnownHosts, &w.HasCredential, &groupID, &w.GroupName,
		&w.LastSyncError, &lastSyncAt,
		&w.CreatedAt, &w.UpdatedAt,
	); err != nil {
		return Workspace{}, err
	}
	if ownerID.Valid {
		id := int(ownerID.Int64)
		w.OwnerID = &id
	}
	if groupID.Valid {
		id := int(groupID.Int64)
		w.GroupID = &id
	}
	if lastSyncAt.Valid {
		t := lastSyncAt.Time
		w.LastSyncAt = &t
	}
	return w, nil
}
