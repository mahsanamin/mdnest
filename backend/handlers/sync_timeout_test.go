package handlers

import (
	"net"
	"os/exec"
	"testing"
	"time"
)

// TestGitRunInReturnsWhenRemoteStalls: the git-sync pull/push helper must give
// up on a remote that accepts the connection and never answers, instead of
// hanging the request (and its OS thread) forever.
func TestGitRunInReturnsWhenRemoteStalls(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	held := make(chan net.Conn, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			held <- c
		}
	}()
	defer func() {
		for len(held) > 0 {
			(<-held).Close()
		}
	}()

	old := gitOpTimeout
	gitOpTimeout = time.Second
	t.Cleanup(func() { gitOpTimeout = old })

	done := make(chan error, 1)
	go func() {
		_, err := gitRunIn(t.TempDir(), []string{"GIT_TERMINAL_PROMPT=0"}, "ls-remote", "http://"+ln.Addr().String()+"/team.git")
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("ls-remote against a stalled remote reported success")
		}
	case <-time.After(20 * time.Second):
		t.Fatal("gitRunIn still blocked 20s after a 1s timeout")
	}
}
