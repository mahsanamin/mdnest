package storage

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"strings"
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
