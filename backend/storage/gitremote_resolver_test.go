package storage

import (
	"slices"
	"strings"
	"testing"
	"time"
)

type stubResolver struct {
	spec RemoteSpec
	ok   bool
	err  error
}

func (s stubResolver) ResolveRemote(string) (RemoteSpec, bool, error) { return s.spec, s.ok, s.err }

func envContains(env []string, prefix string) bool {
	return slices.ContainsFunc(env, func(e string) bool { return strings.HasPrefix(e, prefix) })
}

func TestPlanHTTPSEmbedsUsernameAndStagesAskpass(t *testing.T) {
	plan, err := planFromSpec(RemoteSpec{
		Transport:  "https",
		RemoteURL:  "https://gitlab.example.com/grp/ns.git",
		Credential: "glpat-secret",
		Branch:     "", // defaults to main
	})
	if err != nil {
		t.Fatal(err)
	}
	defer plan.cleanup()
	if plan.url != "https://oauth2@gitlab.example.com/grp/ns.git" {
		t.Fatalf("url = %q", plan.url)
	}
	if plan.branch != "main" {
		t.Fatalf("branch = %q, want main", plan.branch)
	}
	if !envContains(plan.env, "GIT_ASKPASS=") || !envContains(plan.env, "MDNEST_GIT_TOKEN_FILE=") {
		t.Fatalf("https env missing askpass wiring: %v", plan.env)
	}
	// The token must never appear in the URL or argv-facing fields.
	if strings.Contains(plan.url, "glpat-secret") {
		t.Fatal("token leaked into the remote URL")
	}
}

func TestPlanSSHWiresGitSSHCommandWithHostVerification(t *testing.T) {
	plan, err := planFromSpec(RemoteSpec{
		Transport:  "ssh",
		RemoteURL:  "git@gitlab.example.com:grp/ns.git",
		Credential: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
		KnownHosts: "gitlab.example.com ssh-ed25519 AAAA",
		Branch:     "release",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer plan.cleanup()
	if plan.url != "git@gitlab.example.com:grp/ns.git" {
		t.Fatalf("ssh url should be used verbatim, got %q", plan.url)
	}
	if plan.branch != "release" {
		t.Fatalf("branch = %q", plan.branch)
	}
	var sshCmd string
	for _, e := range plan.env {
		if strings.HasPrefix(e, "GIT_SSH_COMMAND=") {
			sshCmd = e
		}
	}
	if sshCmd == "" {
		t.Fatalf("missing GIT_SSH_COMMAND: %v", plan.env)
	}
	for _, want := range []string{"-i ", "StrictHostKeyChecking=yes", "UserKnownHostsFile=", "BatchMode=yes"} {
		if !strings.Contains(sshCmd, want) {
			t.Fatalf("GIT_SSH_COMMAND %q missing %q", sshCmd, want)
		}
	}
}

func TestPlanSSHRequiresKey(t *testing.T) {
	if _, err := planFromSpec(RemoteSpec{Transport: "ssh", RemoteURL: "git@h:g/ns.git"}); err == nil {
		t.Fatal("ssh transport without a key must error")
	}
}

func TestResolvePushPrefersResolverThenEnv(t *testing.T) {
	env := remoteConfig{baseURL: "https://env.example.com/grp", username: "oauth2", branch: "main"}
	c := NewIntervalCommitter(t.TempDir(), time.Hour, time.Hour, "ci", "ci@example.com", env)
	defer c.Close()

	// Override wins.
	c.resolver = stubResolver{spec: RemoteSpec{Transport: "https", RemoteURL: "https://ovr.example.com/g/ns.git", Branch: "main"}, ok: true}
	plan, ok, err := c.resolvePush("ns")
	if err != nil || !ok {
		t.Fatalf("resolvePush override: ok=%v err=%v", ok, err)
	}
	plan.cleanup()
	if plan.url != "https://oauth2@ovr.example.com/g/ns.git" {
		t.Fatalf("override url = %q", plan.url)
	}

	// No override → env default.
	c.resolver = stubResolver{ok: false}
	plan, ok, err = c.resolvePush("ns")
	if err != nil || !ok {
		t.Fatalf("resolvePush fallback: ok=%v err=%v", ok, err)
	}
	plan.cleanup()
	if plan.url != "https://oauth2@env.example.com/grp/ns.git" {
		t.Fatalf("fallback url = %q", plan.url)
	}

	// No override and no env remote → local-only (ok=false).
	c.remote = remoteConfig{}
	if _, ok, _ := c.resolvePush("ns"); ok {
		t.Fatal("expected no remote when both resolver and env are empty")
	}
}

func TestLazyResolverDelegates(t *testing.T) {
	var l LazyResolver
	if _, ok, _ := l.ResolveRemote("ns"); ok {
		t.Fatal("unset LazyResolver must resolve nothing")
	}
	l.Set(stubResolver{spec: RemoteSpec{RemoteURL: "https://x/y.git"}, ok: true})
	spec, ok, err := l.ResolveRemote("ns")
	if err != nil || !ok || spec.RemoteURL != "https://x/y.git" {
		t.Fatalf("delegated resolve: ok=%v err=%v spec=%+v", ok, err, spec)
	}
}
