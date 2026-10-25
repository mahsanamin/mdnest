package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// One websocket per visit (v4.8.13): the client opens /api/ws with only a
// token and moves it between notes with "join" messages. Every join must be
// held to the same check as the old per-note handshake, because the handshake
// no longer names a note.

func dialSession(t *testing.T, ts *testServer, token string) (*wsClient, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	u := strings.Replace(ts.srv.URL, "http", "ws", 1) + "/api/ws?token=" + token
	c, resp, err := websocket.Dial(ctx, u, nil)
	if err != nil {
		if resp != nil {
			return nil, resp.StatusCode
		}
		t.Fatalf("dial: %v", err)
	}
	wc := &wsClient{c: c, msgs: make(chan map[string]any, 256)}
	go wc.readAll()
	t.Cleanup(func() { c.Close(websocket.StatusNormalClosure, "") })
	return wc, http.StatusSwitchingProtocols
}

var joinSeq = 0

// join sends a join and returns the server's answer ("joined" or
// "join-error") for it.
func (w *wsClient) join(t *testing.T, ns, path string) map[string]any {
	t.Helper()
	joinSeq++
	seq := joinSeq
	w.send(t, map[string]any{"type": "join", "ns": ns, "path": path, "seq": seq})
	deadline := time.After(2 * time.Second)
	for {
		select {
		case m, ok := <-w.msgs:
			if !ok {
				t.Fatalf("connection closed while joining %s", path)
			}
			if (m["type"] == "joined" || m["type"] == "join-error") && int(m["seq"].(float64)) == seq {
				return m
			}
		case <-deadline:
			t.Fatalf("no answer to the join of %s", path)
		}
	}
}

func TestRoutes_SessionSocketJoinIsHeldToTheGrants(t *testing.T) {
	ts := newTestServer(t, true)
	pat := jwtFor(t, uidPat, "collaborator", nil) // writer of /Shared
	gus := jwtFor(t, uidGus, "collaborator", nil) // reader of /Shared, through a group

	w, code := dialSession(t, ts, pat)
	if w == nil {
		t.Fatalf("a token-only socket was refused: %d", code)
	}
	for _, p := range []string{"Private/p.md", "Shared/../Private/p.md", "Shared/link.md", ".git/config", "", "../beta/x.md"} {
		if m := w.join(t, "alpha", p); m["type"] != "join-error" {
			t.Errorf("joined %q: %v", p, m)
		}
	}
	if m := w.join(t, "beta", "x.md"); m["type"] != "join-error" {
		t.Errorf("joined a namespace with no grant: %v", m)
	}
	if m := w.join(t, "../alpha", "Shared/a.md"); m["type"] != "join-error" || m["error"] != "invalid-namespace" {
		t.Errorf("joined through a bad namespace name: %v", m)
	}
	m := w.join(t, "alpha", "Shared/a.md")
	if m["type"] != "joined" || m["readOnly"] == true || m["path"] != "Shared/a.md" {
		t.Fatalf("a writer could not join: %v", m)
	}

	r, _ := dialSession(t, ts, gus)
	if m := r.join(t, "alpha", "Shared/a.md"); m["type"] != "joined" || m["readOnly"] != true {
		t.Fatalf("a reader joined without read-only: %v", m)
	}
	time.Sleep(100 * time.Millisecond)
	r.send(t, map[string]any{"type": "content", "content": "INJECTED"})
	r.send(t, map[string]any{"type": "cursor", "line": 3})
	if m := w.waitFor("content", 400*time.Millisecond); m != nil {
		t.Errorf("a reader's content reached a writer: %v", m)
	}
	w.send(t, map[string]any{"type": "content", "content": "REAL EDIT"})
	if m := r.waitFor("content", 2*time.Second); m == nil || m["content"] != "REAL EDIT" {
		t.Errorf("a writer's live edit did not reach the reader: %v", m)
	}

	// A refused join takes the socket out of the note it was in: it is
	// leaving that note anyway, and must not keep receiving it.
	if m := w.join(t, "alpha", "Private/p.md"); m["type"] != "join-error" {
		t.Fatalf("joined Private: %v", m)
	}
	if m := r.waitFor("leave", 2*time.Second); m == nil {
		t.Error("a refused join left the writer in its old note")
	}
	r.send(t, map[string]any{"type": "cursor", "line": 1})
	w.send(t, map[string]any{"type": "content", "content": "AFTER"})
	if m := r.waitFor("content", 400*time.Millisecond); m != nil {
		t.Errorf("a socket in no note still sent content: %v", m)
	}
}

func TestRoutes_SessionSocketSwitchesNotes(t *testing.T) {
	ts := newTestServer(t, true)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	pat := jwtFor(t, uidPat, "collaborator", nil)
	o, _ := dialSession(t, ts, owen)
	p, _ := dialSession(t, ts, pat)
	if m := p.join(t, "alpha", "Shared/a.md"); m["type"] != "joined" {
		t.Fatal(m)
	}
	// "joined" is sent before the server adds the socket to the note, so
	// wait for Pat's presence (sent once Pat is in) before Owen joins, or
	// Owen's "join" can go out while Pat is not yet there to receive it.
	if m := p.waitFor("presence", 2*time.Second); m == nil {
		t.Fatal("no presence after joining")
	}
	if m := o.join(t, "alpha", "Shared/a.md"); m["type"] != "joined" {
		t.Fatal(m)
	}
	if m := p.waitFor("join", 2*time.Second); m == nil {
		t.Fatal("no join event")
	}
	// Owen moves to another note on the same socket: Pat sees him leave,
	// and Owen gets no more of a.md.
	if m := o.join(t, "alpha", "Private/p.md"); m["type"] != "joined" {
		t.Fatal(m)
	}
	if m := p.waitFor("leave", 2*time.Second); m == nil {
		t.Error("switching notes did not leave the old one")
	}
	p.send(t, map[string]any{"type": "content", "content": "FOR A ONLY"})
	if m := o.waitFor("content", 400*time.Millisecond); m != nil {
		t.Errorf("the old note's content followed the socket: %v", m)
	}
	// "leave-note" leaves without joining anything.
	if m := o.join(t, "alpha", "Shared/a.md"); m["type"] != "joined" {
		t.Fatal(m)
	}
	o.send(t, map[string]any{"type": "leave-note"})
	if m := p.waitFor("leave", 2*time.Second); m == nil {
		t.Error("leave-note did not leave")
	}
	// The old URL still works for a tab from before the upgrade.
	if c, code := dialWS(t, ts, pat, "Shared/a.md"); c == nil {
		t.Errorf("the per-note URL stopped working: %d", code)
	}
}

func TestRoutes_SessionSocketJoinsAreRateLimited(t *testing.T) {
	ts := newTestServer(t, true)
	w, _ := dialSession(t, ts, jwtFor(t, uidOwen, "collaborator", nil))
	limited := 0
	for i := 0; i < 40; i++ {
		p := "Shared/a.md"
		if i%2 == 1 {
			p = "Private/p.md"
		}
		if m := w.join(t, "alpha", p); m["type"] == "join-error" && m["error"] == "rate" {
			limited++
		}
	}
	if limited == 0 {
		t.Error("40 joins in a burst were all accepted")
	}
	time.Sleep(300 * time.Millisecond)
	if m := w.join(t, "alpha", "Shared/a.md"); m["type"] != "joined" {
		t.Errorf("joining again after a pause was refused: %v", m)
	}
}

// A grant removed while the socket is in the note: the access-changed that
// follows takes it out of the note, and joining again is refused.
func TestRoutes_SessionSocketLeavesANoteWhenAccessIsRemoved(t *testing.T) {
	ts := newTestServer(t, true)
	w, _ := dialSession(t, ts, jwtFor(t, uidPat, "collaborator", nil))
	if m := w.join(t, "alpha", "Shared/a.md"); m["type"] != "joined" {
		t.Fatal(m)
	}
	ts.grants.revoke(uidPat)
	ts.hub.BroadcastAccessChanged()
	m := w.waitFor("note-left", 2*time.Second)
	if m == nil || m["path"] != "Shared/a.md" {
		t.Fatalf("still in the note after its grant was removed: %v", m)
	}
	if m := w.join(t, "alpha", "Shared/a.md"); m["type"] != "join-error" {
		t.Errorf("joined again without a grant: %v", m)
	}
}

// A removed chat member leaves the chat, and only the chat: the rest of
// their visit keeps its socket.
func TestPrivateChat_RemovalTakesTheSessionSocketOutOfTheChatOnly(t *testing.T) {
	cs := newChatServer(t)
	owen := jwtFor(t, uidOwen, "collaborator", nil)
	nate := jwtFor(t, uidNate, "collaborator", nil)
	n, _ := dialSession(t, cs.testServer, nate)
	if m := n.join(t, "alpha", "Chats/secret.md"); m["type"] != "join-error" {
		t.Fatalf("a non-member joined the chat: %v", m)
	}
	cs.do(owen, http.MethodPost, "/api/chat/members?"+secretQ, strings.NewReader(`{"userId":6}`), "application/json")
	if m := n.join(t, "alpha", "Chats/secret.md"); m["type"] != "joined" {
		t.Fatalf("an invited member could not join: %v", m)
	}
	cs.do(owen, http.MethodDelete, "/api/chat/members?"+secretQ+"&userId=6", nil, "")
	if m := n.waitFor("note-left", 3*time.Second); m == nil {
		t.Fatal("the removed member stayed in the chat")
	}
	if m := n.join(t, "alpha", "Chats/secret.md"); m["type"] != "join-error" {
		t.Errorf("the removed member joined the chat again: %v", m)
	}
	if m := n.join(t, "alpha", "Chats/open.md"); m["type"] != "joined" {
		t.Errorf("the rest of the visit lost its socket: %v", m)
	}
}

// API tokens are for the CLI and agents; the socket takes a session JWT only.
func TestRoutes_SessionSocketRefusesAPITokens(t *testing.T) {
	ts := newTestServer(t, true)
	tok, _, err := ts.tokens.CreateAPIToken("ci", uidPat, "pat", "collaborator")
	if err != nil {
		t.Fatal(err)
	}
	if c, code := dialSession(t, ts, tok); c != nil || code != http.StatusUnauthorized {
		t.Errorf("an API token opened a socket: %d", code)
	}
}

func (w *wsClient) readAll() {
	for {
		_, data, err := w.c.Read(context.Background())
		if err != nil {
			close(w.msgs)
			return
		}
		var m map[string]any
		_ = json.Unmarshal(data, &m)
		w.msgs <- m
	}
}
