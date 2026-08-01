package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// WorkspaceHandler serves per-workspace git remote configuration (multi mode).
//
//   - /api/admin/workspaces  (superadmin) — CRUD over shared/team workspaces.
//   - /api/me/workspace      (any user)   — the caller's own personal workspace.
//
// The stored credential (PAT / SSH key) is never returned to a client; responses
// only report has_credential so the UI can show "configured".
// userLookup resolves a user's email, used to name their personal namespace.
type userLookup interface {
	GetUserByID(id int) (*store.User, error)
}

// grantWriter ensures a user has an access grant on their personal namespace so
// the standard grant-based authorization covers it (no special-casing).
type grantWriter interface {
	GetGrantsForUser(userID int) ([]store.Grant, error)
	CreateGrant(userID int, namespace, path, permission string, grantedBy *int) (*store.Grant, error)
}

type WorkspaceHandler struct {
	store  store.WorkspaceStore
	users  userLookup
	grants grantWriter
	// stg materialises a namespace (MkdirAll) when a workspace is configured so
	// it is listed and writable even before it holds a note. nil in single mode.
	stg storage.Storage
	// allowedHosts, when non-empty, restricts remote URLs to these hosts
	// (defence-in-depth against SSRF; the primary control is the writer's
	// egress NetworkPolicy). Empty = any host allowed.
	allowedHosts []string
	// encryptionConfigured reports that the server has a non-default secret to
	// seal credentials at rest. When false the handler fails closed: it refuses
	// to enable mirroring or store a credential, so the most sensitive data mdnest
	// holds is never sealed under a default key.
	encryptionConfigured bool
}

// NewWorkspaceHandler builds a workspace handler. stg may be nil (single mode);
// allowedHosts may be nil. encryptionConfigured must be true for the handler to
// accept mirroring/credentials (fail-closed when the sealing secret is default).
func NewWorkspaceHandler(ws store.WorkspaceStore, users userLookup, grants grantWriter, stg storage.Storage, allowedHosts []string, encryptionConfigured bool) *WorkspaceHandler {
	lower := make([]string, 0, len(allowedHosts))
	for _, h := range allowedHosts {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			lower = append(lower, h)
		}
	}
	return &WorkspaceHandler{store: ws, users: users, grants: grants, stg: stg, allowedHosts: lower, encryptionConfigured: encryptionConfigured}
}

// requireEncryptionForMirror fails closed when mirroring would seal a credential
// but the server has no dedicated sealing secret (MDNEST_ENCRYPTION_KEY unset and
// the JWT secret still the default). Refusing here means user-supplied PATs and
// SSH keys are never encrypted under a default, guessable key.
func (h *WorkspaceHandler) requireEncryptionForMirror(gitEnabled bool) error {
	if !gitEnabled || h.encryptionConfigured {
		return nil
	}
	return errors.New("git mirroring is disabled on this server: set MDNEST_ENCRYPTION_KEY (or a non-default MDNEST_JWT_SECRET) so credentials can be sealed at rest")
}

// requireEncryptionForCredential fails closed when a group would seal a shared
// credential without a dedicated sealing secret.
func (h *WorkspaceHandler) requireEncryptionForCredential(cred *string) error {
	if cred == nil || strings.TrimSpace(*cred) == "" || h.encryptionConfigured {
		return nil
	}
	return errors.New("cannot store a credential on this server: set MDNEST_ENCRYPTION_KEY (or a non-default MDNEST_JWT_SECRET) so credentials can be sealed at rest")
}

// personalNamespace resolves the caller's personal-workspace namespace: their
// email address, so it is recognisable (not an opaque user-<id>).
func (h *WorkspaceHandler) personalNamespace(userID int) (string, error) {
	if h.users == nil {
		return "", errors.New("user lookup unavailable")
	}
	u, err := h.users.GetUserByID(userID)
	if err != nil {
		return "", err
	}
	if u == nil || strings.TrimSpace(u.Email) == "" {
		return "", errors.New("user has no email")
	}
	return strings.TrimSpace(u.Email), nil
}

// ensurePersonalGrant gives the owner a write grant on their personal namespace
// (idempotent) so the normal grant-based authorization lets them read/write it.
func (h *WorkspaceHandler) ensurePersonalGrant(userID int, ns string) {
	if h.grants == nil {
		return
	}
	if grants, err := h.grants.GetGrantsForUser(userID); err == nil {
		for _, g := range grants {
			if g.Namespace == ns && g.Path == "/" {
				return
			}
		}
	}
	if _, err := h.grants.CreateGrant(userID, ns, "/", "write", &userID); err != nil {
		log.Printf("workspaces: could not grant %q to user %d: %v", ns, userID, err)
	}
}

// ensureNamespace materialises a namespace so it is listed (and writable) even
// before it holds a note — MkdirAll registers it in the working set. Best
// effort: a failure is logged, not fatal (the git config is already saved).
func (h *WorkspaceHandler) ensureNamespace(ctx context.Context, ns string) {
	if h.stg == nil || ns == "" {
		return
	}
	if err := h.stg.MkdirAll(ctx, ns, ""); err != nil {
		log.Printf("workspaces: could not create namespace %q: %v", ns, err)
	}
}

// namespacePattern bounds admin-supplied namespace names to a safe charset (no
// path separators, no traversal).
var namespacePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type workspaceRequest struct {
	Namespace  string `json:"namespace"`          // admin create only
	GroupID    *int   `json:"group_id,omitempty"` // admin create only: add to a group
	GitEnabled bool   `json:"git_enabled"`
	Transport  string `json:"transport"`
	RemoteURL  string `json:"remote_url"`
	Username   string `json:"username"`
	Branch     string `json:"branch"`
	KnownHosts string `json:"known_hosts"`
	// Credential is the plaintext PAT (https) or SSH private key. Omit / null to
	// keep the stored credential unchanged on update; send a value to replace it
	// (empty string clears it).
	Credential *string `json:"credential"`
}

// --- admin CRUD: /api/admin/workspaces (superadmin) ------------------------

func (h *WorkspaceHandler) HandleAdmin(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.adminList(w, r)
	case http.MethodPost:
		h.adminCreate(w, r)
	case http.MethodPut:
		h.adminUpdate(w, r)
	case http.MethodDelete:
		h.adminDelete(w, r)
	default:
		wsError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *WorkspaceHandler) adminList(w http.ResponseWriter, _ *http.Request) {
	list, err := h.store.List()
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to list workspaces")
		return
	}
	wsJSON(w, http.StatusOK, list)
}

func (h *WorkspaceHandler) adminCreate(w http.ResponseWriter, r *http.Request) {
	var req workspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	ns := strings.TrimSpace(req.Namespace)
	if !namespacePattern.MatchString(ns) {
		wsError(w, http.StatusBadRequest, "invalid namespace (allowed: letters, digits, . _ -)")
		return
	}
	if strings.HasPrefix(ns, "user-") {
		wsError(w, http.StatusBadRequest, "the user- prefix is reserved for personal workspaces")
		return
	}
	if existing, _ := h.store.GetByNamespace(ns); existing != nil {
		wsError(w, http.StatusConflict, "a workspace already exists for this namespace")
		return
	}
	// Grouped create: the namespace inherits the group's remote/credential, so
	// only the namespace is needed (its repo is <group base>/<namespace>.git).
	if req.GroupID != nil {
		grp, err := h.store.GetGroup(*req.GroupID)
		if err != nil {
			wsError(w, http.StatusInternalServerError, "group lookup failed")
			return
		}
		if grp == nil {
			wsError(w, http.StatusBadRequest, "group not found")
			return
		}
		ws, err := h.store.CreateInGroup(*req.GroupID, ns, true)
		if err != nil {
			wsError(w, http.StatusInternalServerError, "failed to create workspace in group")
			return
		}
		h.ensureNamespace(r.Context(), ns)
		wsJSON(w, http.StatusCreated, ws)
		return
	}
	in, err := h.inputFrom(req, req.GitEnabled)
	if err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.requireEncryptionForMirror(in.GitEnabled); err != nil {
		wsError(w, http.StatusForbidden, err.Error())
		return
	}
	if err := requireCredentialForMirror(in, false); err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	in.Namespace = ns
	in.OwnerID = nil // shared/team workspace
	in.IsPersonal = false
	ws, err := h.store.Create(in)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to create workspace")
		return
	}
	h.ensureNamespace(r.Context(), ns)
	wsJSON(w, http.StatusCreated, ws)
}

func (h *WorkspaceHandler) adminUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	existing, err := h.store.Get(id)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if existing == nil {
		wsError(w, http.StatusNotFound, "workspace not found")
		return
	}
	if existing.IsPersonal {
		wsError(w, http.StatusForbidden, "personal workspaces are managed by their owner via /api/me/workspace")
		return
	}
	var req workspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	// A grouped workspace inherits the group's remote, so an admin can only
	// toggle it on/off here; a standalone one takes the full config.
	var in store.WorkspaceInput
	if existing.GroupID != nil {
		in = store.WorkspaceInput{GitEnabled: req.GitEnabled}
	} else {
		var err error
		if in, err = h.inputFrom(req, req.GitEnabled); err != nil {
			wsError(w, http.StatusBadRequest, err.Error())
			return
		}
		if err := h.requireEncryptionForMirror(in.GitEnabled); err != nil {
			wsError(w, http.StatusForbidden, err.Error())
			return
		}
		if err := requireCredentialForMirror(in, existing.HasCredential); err != nil {
			wsError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	ws, err := h.store.Update(id, in)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to update workspace")
		return
	}
	wsJSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) adminDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	existing, _ := h.store.Get(id)
	if existing != nil && existing.IsPersonal {
		wsError(w, http.StatusForbidden, "personal workspaces are managed by their owner")
		return
	}
	deleted, err := h.store.Delete(id)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to delete workspace")
		return
	}
	if !deleted {
		wsError(w, http.StatusNotFound, "workspace not found")
		return
	}
	wsJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// --- workspace groups: /api/admin/workspace-groups (superadmin) ------------

// groupNamePattern bounds a group's display name to a safe, readable charset.
var groupNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$`)

type groupRequest struct {
	Name       string  `json:"name"`
	Transport  string  `json:"transport"`
	BaseURL    string  `json:"base_url"`
	Username   string  `json:"username"`
	Branch     string  `json:"branch"`
	KnownHosts string  `json:"known_hosts"`
	Credential *string `json:"credential"`
}

func (h *WorkspaceHandler) HandleGroups(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.groupsList(w)
	case http.MethodPost:
		h.groupsCreate(w, r)
	case http.MethodPut:
		h.groupsUpdate(w, r)
	case http.MethodDelete:
		h.groupsDelete(w, r)
	default:
		wsError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *WorkspaceHandler) groupsList(w http.ResponseWriter) {
	list, err := h.store.ListGroups()
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to list groups")
		return
	}
	wsJSON(w, http.StatusOK, list)
}

func (h *WorkspaceHandler) groupsCreate(w http.ResponseWriter, r *http.Request) {
	var req groupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	name := strings.TrimSpace(req.Name)
	if !groupNamePattern.MatchString(name) {
		wsError(w, http.StatusBadRequest, "invalid group name")
		return
	}
	if existing, _ := h.store.GetGroupByName(name); existing != nil {
		wsError(w, http.StatusConflict, "a group with this name already exists")
		return
	}
	if err := h.requireEncryptionForCredential(req.Credential); err != nil {
		wsError(w, http.StatusForbidden, err.Error())
		return
	}
	in, err := h.groupInputFrom(req)
	if err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	in.Name = name
	g, err := h.store.CreateGroup(in)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to create group")
		return
	}
	wsJSON(w, http.StatusCreated, g)
}

func (h *WorkspaceHandler) groupsUpdate(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	existing, err := h.store.GetGroup(id)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if existing == nil {
		wsError(w, http.StatusNotFound, "group not found")
		return
	}
	var req groupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	name := strings.TrimSpace(req.Name)
	if !groupNamePattern.MatchString(name) {
		wsError(w, http.StatusBadRequest, "invalid group name")
		return
	}
	if err := h.requireEncryptionForCredential(req.Credential); err != nil {
		wsError(w, http.StatusForbidden, err.Error())
		return
	}
	in, err := h.groupInputFrom(req)
	if err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	in.Name = name
	g, err := h.store.UpdateGroup(id, in)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to update group")
		return
	}
	wsJSON(w, http.StatusOK, g)
}

func (h *WorkspaceHandler) groupsDelete(w http.ResponseWriter, r *http.Request) {
	id, ok := workspaceID(w, r)
	if !ok {
		return
	}
	deleted, err := h.store.DeleteGroup(id)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to delete group")
		return
	}
	if !deleted {
		wsError(w, http.StatusNotFound, "group not found")
		return
	}
	wsJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// groupInputFrom validates and builds a group input. The base URL is validated
// like a workspace remote (scheme/host + optional allow-list).
func (h *WorkspaceHandler) groupInputFrom(req groupRequest) (store.WorkspaceGroupInput, error) {
	transport := strings.ToLower(strings.TrimSpace(req.Transport))
	if transport != "ssh" {
		transport = "https"
	}
	baseURL := strings.TrimSpace(req.BaseURL)
	if err := h.validateRemote(transport, baseURL); err != nil {
		return store.WorkspaceGroupInput{}, err
	}
	return store.WorkspaceGroupInput{
		Transport:  transport,
		BaseURL:    baseURL,
		Username:   strings.TrimSpace(req.Username),
		Branch:     strings.TrimSpace(req.Branch),
		KnownHosts: req.KnownHosts,
		Credential: req.Credential,
	}, nil
}

// --- personal workspace: /api/me/workspace (any authenticated user) --------

func (h *WorkspaceHandler) HandleMine(w http.ResponseWriter, r *http.Request) {
	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		wsError(w, http.StatusUnauthorized, "authentication required")
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.mineGet(w, uc.ID)
	case http.MethodPut:
		h.minePut(w, r, uc.ID)
	case http.MethodDelete:
		h.mineDelete(w, uc.ID)
	default:
		wsError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (h *WorkspaceHandler) mineGet(w http.ResponseWriter, userID int) {
	ws, err := h.store.GetPersonalByOwner(userID)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if ws == nil {
		// No personal workspace yet: show the derived namespace (the caller's
		// email) so the UI can indicate where their notes will live.
		ns, err := h.personalNamespace(userID)
		if err != nil {
			wsError(w, http.StatusInternalServerError, "could not resolve your email")
			return
		}
		wsJSON(w, http.StatusOK, map[string]any{
			"namespace":      ns,
			"is_personal":    true,
			"git_enabled":    false,
			"has_credential": false,
			"configured":     false,
		})
		return
	}
	wsJSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) minePut(w http.ResponseWriter, r *http.Request, userID int) {
	var req workspaceRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		wsError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	in, err := h.inputFrom(req, req.GitEnabled)
	if err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	// A personal workspace is always owned by the caller and named after their
	// email — never taken from the request, so a user can't target another
	// namespace.
	ns, err := h.personalNamespace(userID)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "could not resolve your email")
		return
	}
	in.Namespace = ns
	in.OwnerID = &userID
	in.IsPersonal = true

	existing, err := h.store.GetPersonalByOwner(userID)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	// If the naming scheme changed (an older user-<id> row), replace it so the
	// personal workspace is keyed by the email going forward.
	if existing != nil && existing.Namespace != ns {
		_, _ = h.store.Delete(existing.ID)
		existing = nil
	}
	if err := h.requireEncryptionForMirror(in.GitEnabled); err != nil {
		wsError(w, http.StatusForbidden, err.Error())
		return
	}
	if err := requireCredentialForMirror(in, existing != nil && existing.HasCredential); err != nil {
		wsError(w, http.StatusBadRequest, err.Error())
		return
	}
	var ws *store.Workspace
	if existing == nil {
		ws, err = h.store.Create(in)
	} else {
		ws, err = h.store.Update(existing.ID, in)
	}
	if err != nil {
		wsError(w, http.StatusInternalServerError, "failed to save workspace")
		return
	}
	// Only materialise the namespace once the workspace actually mirrors to a
	// repo the owner controls — then it is durable by construction, which is
	// what makes user-initiated creation defensible here at all. Creating it
	// for a mirroring-disabled workspace would leave notes in a runtime-created
	// namespace with no remote; on the local backend that is the container's
	// writable layer, which `mdnest-server rebuild` discards and git-sync never
	// sees. Namespaces otherwise come from mounts or operator config.
	if in.GitEnabled {
		h.ensureNamespace(r.Context(), ns)
		h.ensurePersonalGrant(userID, ns)
	}
	wsJSON(w, http.StatusOK, ws)
}

func (h *WorkspaceHandler) mineDelete(w http.ResponseWriter, userID int) {
	existing, err := h.store.GetPersonalByOwner(userID)
	if err != nil {
		wsError(w, http.StatusInternalServerError, "lookup failed")
		return
	}
	if existing == nil {
		wsError(w, http.StatusNotFound, "no personal workspace")
		return
	}
	if _, err := h.store.Delete(existing.ID); err != nil {
		wsError(w, http.StatusInternalServerError, "failed to delete workspace")
		return
	}
	wsJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

// --- shared helpers --------------------------------------------------------

// inputFrom builds a store.WorkspaceInput from a request, normalising the
// transport and validating the remote when git is enabled.
func (h *WorkspaceHandler) inputFrom(req workspaceRequest, gitEnabled bool) (store.WorkspaceInput, error) {
	transport := strings.ToLower(strings.TrimSpace(req.Transport))
	if transport != "ssh" {
		transport = "https"
	}
	remoteURL := strings.TrimSpace(req.RemoteURL)
	if gitEnabled {
		if err := h.validateRemote(transport, remoteURL); err != nil {
			return store.WorkspaceInput{}, err
		}
	}
	return store.WorkspaceInput{
		GitEnabled: gitEnabled,
		Transport:  transport,
		RemoteURL:  remoteURL,
		Username:   strings.TrimSpace(req.Username),
		Branch:     strings.TrimSpace(req.Branch),
		KnownHosts: req.KnownHosts,
		Credential: req.Credential,
	}, nil
}

// requireCredentialForMirror rejects enabling git mirroring without a usable
// credential: mdnest must authenticate to push (durability) and to seed a
// private remote, so an empty token/key would only fail silently in the
// background. hasExistingCredential reports whether one is already stored (kept
// when the request leaves the field blank).
func requireCredentialForMirror(in store.WorkspaceInput, hasExistingCredential bool) error {
	if !in.GitEnabled {
		return nil
	}
	has := hasExistingCredential
	if in.Credential != nil { // a provided value replaces; an empty string clears
		has = strings.TrimSpace(*in.Credential) != ""
	}
	if has {
		return nil
	}
	if in.Transport == "ssh" {
		return errors.New("an SSH private key is required to enable mirroring")
	}
	return errors.New("an access token is required to enable HTTPS mirroring")
}

// validateRemote checks the URL shape per transport and enforces the optional
// host allow-list.
func (h *WorkspaceHandler) validateRemote(transport, remoteURL string) error {
	if remoteURL == "" {
		return errors.New("remote_url is required when git is enabled")
	}
	var host string
	if transport == "ssh" {
		if strings.HasPrefix(remoteURL, "ssh://") {
			u, err := url.Parse(remoteURL)
			if err != nil {
				return fmt.Errorf("invalid ssh url: %w", err)
			}
			host = u.Hostname()
		} else {
			// scp-like: user@host:path
			at := strings.Index(remoteURL, "@")
			colon := strings.Index(remoteURL, ":")
			if at <= 0 || colon <= at {
				return errors.New("invalid ssh remote (want user@host:path or ssh://…)")
			}
			host = remoteURL[at+1 : colon]
		}
	} else {
		u, err := url.Parse(remoteURL)
		if err != nil {
			return fmt.Errorf("invalid url: %w", err)
		}
		if u.Scheme != "https" {
			return errors.New("https transport requires an https:// url")
		}
		host = u.Hostname()
	}
	if host == "" {
		return errors.New("remote_url has no host")
	}
	if len(h.allowedHosts) > 0 && !slices.Contains(h.allowedHosts, strings.ToLower(host)) {
		return fmt.Errorf("git host %q is not allowed", host)
	}
	return nil
}

// workspaceID reads and validates the ?id= query parameter.
func workspaceID(w http.ResponseWriter, r *http.Request) (int, bool) {
	id, err := strconv.Atoi(r.URL.Query().Get("id"))
	if err != nil || id <= 0 {
		wsError(w, http.StatusBadRequest, "missing or invalid id")
		return 0, false
	}
	return id, true
}

func wsError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func wsJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
