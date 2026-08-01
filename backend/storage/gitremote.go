package storage

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"strings"
	"sync"
)

// remoteConfig describes how the committer mirrors each per-namespace git repo
// to a remote — one git repository per workspace/namespace, e.g.
// https://gitlab.example.com/mdnest-workspaces/<ns>.git — authenticated over
// HTTPS with a Personal Access Token. Mirroring is the real durability in the
// HA topology (app replicas git-sync a read-only clone from these remotes); it
// is disabled when baseURL is empty (local-only history).
//
// Credentials never appear in argv or in .git/config: the PAT lives in a file
// (a mounted Kubernetes Secret) and git reads it through a generated GIT_ASKPASS
// helper. The remote URL carries only the username.
type remoteConfig struct {
	baseURL   string // e.g. https://gitlab.example.com/mdnest-workspaces (no trailing slash)
	username  string // HTTPS basic-auth username (GitLab PAT: "oauth2")
	branch    string // branch to push (default "main")
	tokenFile string // path to the file holding the PAT
	askpass   string // path to the generated GIT_ASKPASS helper (empty if no token)
}

func (c remoteConfig) enabled() bool { return c.baseURL != "" }

// remoteURL returns the per-namespace remote URL with the username embedded
// (never the token), e.g. https://oauth2@gitlab.example.com/group/<ns>.git.
func (c remoteConfig) remoteURL(ns string) (string, error) {
	u, err := url.Parse(c.baseURL)
	if err != nil {
		return "", err
	}
	if c.username != "" {
		u.User = url.User(c.username)
	}
	u.Path = path.Join(u.Path, ns+".git")
	return u.String(), nil
}

// pushEnv returns the environment for a git push: prompts disabled and, when a
// token is configured, the askpass helper wired to the token file.
func (c remoteConfig) pushEnv() []string {
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if c.askpass != "" {
		env = append(env,
			"GIT_ASKPASS="+c.askpass,
			"MDNEST_GIT_TOKEN_FILE="+c.tokenFile,
		)
	}
	return env
}

// remoteConfigFromEnv builds the mirror config from the environment:
//
//	GIT_REMOTE_URL       base URL, one repo per namespace under it (empty=disabled)
//	GIT_REMOTE_USERNAME  HTTPS username (default "oauth2")
//	GIT_REMOTE_BRANCH    branch to push (default "main")
//	GIT_TOKEN_FILE       path to a file with the PAT (preferred: a mounted Secret)
//	GIT_TOKEN            raw PAT (fallback; staged to a 0600 temp file)
func remoteConfigFromEnv() (remoteConfig, error) {
	base := strings.TrimRight(strings.TrimSpace(os.Getenv("GIT_REMOTE_URL")), "/")
	if base == "" {
		return remoteConfig{}, nil
	}
	cfg := remoteConfig{
		baseURL:  base,
		username: envOr("GIT_REMOTE_USERNAME", "oauth2"),
		branch:   envOr("GIT_REMOTE_BRANCH", "main"),
	}
	tokenFile := strings.TrimSpace(os.Getenv("GIT_TOKEN_FILE"))
	if tokenFile == "" {
		if tok := os.Getenv("GIT_TOKEN"); tok != "" {
			staged, err := writeSecretTemp("mdnest-git-token-*", []byte(tok))
			if err != nil {
				return remoteConfig{}, fmt.Errorf("git remote: staging token: %w", err)
			}
			tokenFile = staged
		}
	}
	if tokenFile != "" {
		cfg.tokenFile = tokenFile
		askpass, err := writeAskpass()
		if err != nil {
			return remoteConfig{}, fmt.Errorf("git remote: askpass helper: %w", err)
		}
		cfg.askpass = askpass
	}
	return cfg, nil
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

// writeSecretTemp writes data to a new 0600 temp file and returns its path.
func writeSecretTemp(pattern string, data []byte) (string, error) {
	f, err := os.CreateTemp("", pattern)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := f.Chmod(0o600); err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		return "", err
	}
	return f.Name(), nil
}

// writeAskpass writes a GIT_ASKPASS helper that prints the token file's
// contents, so the PAT never appears in argv or git config. Git calls it only
// for the password prompt (the username is already in the URL).
func writeAskpass() (string, error) {
	const script = "#!/bin/sh\ncat \"$MDNEST_GIT_TOKEN_FILE\"\n"
	f, err := os.CreateTemp("", "mdnest-askpass-*.sh")
	if err != nil {
		return "", err
	}
	defer f.Close()
	if err := f.Chmod(0o700); err != nil {
		return "", err
	}
	if _, err := f.WriteString(script); err != nil {
		return "", err
	}
	return f.Name(), nil
}

// --- per-namespace remote overrides (multi mode) ---------------------------
//
// The env config above is the coarse default shared by every namespace. A
// RemoteResolver lets a higher layer (the Postgres workspaces table) override
// the mirror for a single namespace: a different repository, over HTTPS with a
// PAT or over SSH with a deploy key. The resolver returns plain data
// (RemoteSpec); the committer stages the credential files and builds the push,
// so the storage package never couples to the database.

// RemoteSpec is a per-namespace mirror override. Credential is the secret PAT
// (https) or SSH private key (ssh); KnownHosts is public host-key material used
// for SSH StrictHostKeyChecking. RemoteURL is the full repository URL.
type RemoteSpec struct {
	Transport  string // "https" (default) or "ssh"
	RemoteURL  string // full remote repo URL for this namespace
	Username   string // https basic-auth username (ignored for ssh)
	Branch     string // branch to push (default "main")
	Credential string // https PAT or ssh private key (secret)
	KnownHosts string // ssh known_hosts entries (public)
}

// RemoteResolver resolves the mirror override for a namespace. It is
// implemented outside the storage package (e.g. an adapter over the workspaces
// store) so storage never imports the database layer. ok=false means the
// namespace has no override and the env default applies.
type RemoteResolver interface {
	ResolveRemote(ns string) (spec RemoteSpec, ok bool, err error)
}

// RemoteResolverFunc adapts a plain function to a RemoteResolver, so the
// database-backed resolver can be wired in main without a named type.
type RemoteResolverFunc func(ns string) (RemoteSpec, bool, error)

// ResolveRemote calls f.
func (f RemoteResolverFunc) ResolveRemote(ns string) (RemoteSpec, bool, error) { return f(ns) }

// LazyResolver is a RemoteResolver whose delegate is set after construction.
// The DB-backed resolver only exists once multi-mode Postgres is connected,
// which happens after the storage backend is built; until then this resolves
// nothing (ok=false → env default). Safe for concurrent use.
type LazyResolver struct {
	mu       sync.RWMutex
	delegate RemoteResolver
}

// Set installs (or replaces) the delegate resolver.
func (l *LazyResolver) Set(r RemoteResolver) {
	l.mu.Lock()
	l.delegate = r
	l.mu.Unlock()
}

// ResolveRemote delegates, returning ok=false until a delegate is set.
func (l *LazyResolver) ResolveRemote(ns string) (RemoteSpec, bool, error) {
	l.mu.RLock()
	d := l.delegate
	l.mu.RUnlock()
	if d == nil {
		return RemoteSpec{}, false, nil
	}
	return d.ResolveRemote(ns)
}

// pushPlan is a resolved, ready-to-run mirror push for one namespace: the fully
// authenticated remote URL, the target branch, the process environment, and a
// cleanup that removes any staged credential files after the push.
type pushPlan struct {
	url     string
	branch  string
	env     []string
	cleanup func()
}

// planFromEnv builds a push plan for the coarse env-default remote (HTTPS/PAT,
// askpass staged once at startup — nothing to clean up per push).
func (c remoteConfig) plan(ns string) (pushPlan, error) {
	u, err := c.remoteURL(ns)
	if err != nil {
		return pushPlan{}, err
	}
	return pushPlan{url: u, branch: c.branch, env: c.pushEnv(), cleanup: func() {}}, nil
}

// planFromSpec turns a per-namespace RemoteSpec into a push plan, staging the
// credential to a private temp file: an askpass token for HTTPS, or a private
// key (+ optional known_hosts) wired through GIT_SSH_COMMAND for SSH. The
// returned cleanup removes every staged file.
func planFromSpec(spec RemoteSpec) (pushPlan, error) {
	branch := strings.TrimSpace(spec.Branch)
	if branch == "" {
		branch = "main"
	}
	if strings.EqualFold(strings.TrimSpace(spec.Transport), "ssh") {
		return planSSH(spec, branch)
	}
	return planHTTPS(spec, branch)
}

func planHTTPS(spec RemoteSpec, branch string) (pushPlan, error) {
	u, err := url.Parse(spec.RemoteURL)
	if err != nil {
		return pushPlan{}, fmt.Errorf("git remote: parse url: %w", err)
	}
	username := strings.TrimSpace(spec.Username)
	if username == "" {
		username = "oauth2"
	}
	u.User = url.User(username)

	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	cleanup := func() {}
	if spec.Credential != "" {
		tokenFile, err := writeSecretTemp("mdnest-ws-token-*", []byte(spec.Credential))
		if err != nil {
			return pushPlan{}, fmt.Errorf("git remote: staging token: %w", err)
		}
		askpass, err := writeAskpass()
		if err != nil {
			os.Remove(tokenFile)
			return pushPlan{}, fmt.Errorf("git remote: askpass helper: %w", err)
		}
		env = append(env, "GIT_ASKPASS="+askpass, "MDNEST_GIT_TOKEN_FILE="+tokenFile)
		cleanup = func() { os.Remove(tokenFile); os.Remove(askpass) }
	}
	return pushPlan{url: u.String(), branch: branch, env: env, cleanup: cleanup}, nil
}

func planSSH(spec RemoteSpec, branch string) (pushPlan, error) {
	if strings.TrimSpace(spec.Credential) == "" {
		return pushPlan{}, fmt.Errorf("git remote: ssh transport requires a private key")
	}
	key := spec.Credential
	if !strings.HasSuffix(key, "\n") { // OpenSSH refuses keys without a trailing newline
		key += "\n"
	}
	keyFile, err := writeSecretTemp("mdnest-ws-key-*", []byte(key))
	if err != nil {
		return pushPlan{}, fmt.Errorf("git remote: staging ssh key: %w", err)
	}
	// Host-key verification is mandatory (StrictHostKeyChecking=yes). When the
	// workspace supplies known_hosts we point ssh at it; otherwise ssh has no
	// trusted host key and the push fails closed until the operator adds one.
	knownHostsFile := os.DevNull
	cleanup := func() { os.Remove(keyFile) }
	if kh := strings.TrimSpace(spec.KnownHosts); kh != "" {
		f, err := writeSecretTemp("mdnest-ws-knownhosts-*", []byte(spec.KnownHosts+"\n"))
		if err != nil {
			os.Remove(keyFile)
			return pushPlan{}, fmt.Errorf("git remote: staging known_hosts: %w", err)
		}
		knownHostsFile = f
		cleanup = func() { os.Remove(keyFile); os.Remove(f) }
	}
	sshCmd := fmt.Sprintf(
		"ssh -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%s -o BatchMode=yes",
		shellQuote(keyFile), shellQuote(knownHostsFile),
	)
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_SSH_COMMAND="+sshCmd)
	return pushPlan{url: spec.RemoteURL, branch: branch, env: env, cleanup: cleanup}, nil
}

// shellQuote single-quotes a path for embedding in GIT_SSH_COMMAND (git parses
// it with the shell). Temp paths never contain quotes, but this is defensive.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
