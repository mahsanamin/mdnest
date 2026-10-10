package storage

import (
	"context"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// stalledRemote accepts connections and never answers, like a remote behind a
// dropped connection or a black-holed load balancer.
func stalledRemote(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var conns []net.Conn
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			conns = append(conns, c)
			mu.Unlock()
		}
	}()
	t.Cleanup(func() {
		ln.Close()
		mu.Lock()
		defer mu.Unlock()
		for _, c := range conns {
			c.Close()
		}
	})
	return ln.Addr().String()
}

// helpersTalkingTo lists live (non-zombie) processes whose command line
// mentions addr, i.e. git or its git-remote-http helper still holding the socket.
func helpersTalkingTo(addr string) []string {
	var found []string
	entries, _ := os.ReadDir("/proc")
	for _, e := range entries {
		cmdline, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil || !strings.Contains(string(cmdline), addr) {
			continue
		}
		stat, _ := os.ReadFile(filepath.Join("/proc", e.Name(), "stat"))
		if f := strings.Fields(string(stat)); len(f) > 2 && f[2] == "Z" {
			continue
		}
		found = append(found, strings.ReplaceAll(string(cmdline), "\x00", " "))
	}
	return found
}

// TestSyncReturnsWhenRemoteStalls pins the writer thread leak fix: a remote
// that never answers must not block the mirror sync forever. The fetch is
// bounded by gitNetworkTimeout, and the git-remote-http helper holding the
// socket dies with it instead of keeping the call (and its OS thread) stuck.
func TestSyncReturnsWhenRemoteStalls(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	addr := stalledRemote(t)

	old := gitNetworkTimeout
	gitNetworkTimeout = time.Second
	t.Cleanup(func() { gitNetworkTimeout = old })

	root := t.TempDir()
	c := NewIntervalCommitter(root, time.Hour, time.Hour, "ci", "ci@example.com",
		remoteConfig{baseURL: "http://" + addr, branch: "main"})
	defer c.Close()
	if _, err := NewGitStorage(root, c); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "team"), 0o755); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() { done <- c.commit(context.Background(), "team") }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("sync against a stalled remote reported success")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("sync still blocked 20s after a 1s network timeout: a stalled remote strands the writer")
	}

	if runtime.GOOS != "linux" {
		return
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		left := helpersTalkingTo(addr)
		if len(left) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("git processes still talking to the stalled remote after the timeout: %q", left)
		}
		time.Sleep(100 * time.Millisecond)
	}
}
