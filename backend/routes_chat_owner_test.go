package main

// Only a chat's owner, a namespace admin or a superadmin may delete it, driven
// through the real route table and auth middleware. Every way a chat can be
// removed is tried by a writer who does not own it: DELETE of the note and of
// its folder, an upload over it, a PUT or prepend that turns it back into a
// plain note, and a PUT that hands it to someone else.

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const ownedChat = "---\nmdnest-chat: true\ntitle: Owned\nowner: user3\n---\n\n#### user6 · 2026-10-07T10:00:00Z\nhello\n"

func writeFixture(t *testing.T, cs *chatServer, rel, body string) {
	t.Helper()
	p := filepath.Join(cs.root, filepath.FromSlash(rel))
	os.MkdirAll(filepath.Dir(p), 0o755)
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestChatDelete_OnlyOwnerOrAdmin(t *testing.T) {
	cs := newChatServer(t)
	owner := jwtFor(t, uidOwen, "collaborator", nil) // user3
	writer := jwtFor(t, uidNate, "collaborator", nil)
	admin := jwtFor(t, uidAdmin, "admin", nil)

	// A writer who does not own it: refused, and the chat is still there.
	writeFixture(t, cs, "alpha/Team/room.md", ownedChat)
	q := "/api/note?ns=alpha&path=Team/room.md"
	if code, body := cs.do(writer, http.MethodDelete, q, nil, ""); code != http.StatusForbidden || !strings.Contains(body, "owner") {
		t.Fatalf("writer deleted someone else's chat: %d %s", code, body)
	}
	if !cs.exists("alpha/Team/room.md") {
		t.Fatal("chat gone after a refused delete")
	}
	// The same writer through the folder holding it.
	if code, body := cs.do(writer, http.MethodDelete, "/api/note?ns=alpha&path=Team", nil, ""); code != http.StatusForbidden || !strings.Contains(body, "room.md") {
		t.Fatalf("writer deleted a folder holding someone else's chat: %d %s", code, body)
	}
	if !cs.exists("alpha/Team/room.md") {
		t.Fatal("chat gone after a refused folder delete")
	}

	// The chat reports who may delete it.
	var r struct {
		Owner     string `json:"owner"`
		CanDelete bool   `json:"canDelete"`
	}
	_, body := cs.get(writer, "/api/chat?ns=alpha&path=Team/room.md")
	json.Unmarshal([]byte(body), &r)
	if r.Owner != "user3" || r.CanDelete {
		t.Fatalf("writer's view: %+v", r)
	}
	_, body = cs.get(owner, "/api/chat?ns=alpha&path=Team/room.md")
	json.Unmarshal([]byte(body), &r)
	if !r.CanDelete {
		t.Fatalf("owner's view: %+v", r)
	}
	_, list := cs.get(writer, "/api/chats?ns=alpha")
	if !strings.Contains(list, `"path":"Team/room.md","title":"Owned","count":1,"lastAuthor":"user6"`) || strings.Contains(list, `"path":"Team/room.md","title":"Owned","count":1,"lastAuthor":"user6","lastTime":"2026-10-07T10:00:00Z","lastText":"hello","owner":"user3","canDelete":true`) {
		t.Fatalf("list should show the chat without canDelete for a non-owner: %s", list)
	}

	// The owner and a namespace admin may. (A superadmin passes the same
	// admin check, on a namespace it has been granted: in multi mode it has
	// no implicit access to notes at all, issue #123.)
	for name, tok := range map[string]string{"owner": owner, "ns admin": admin} {
		writeFixture(t, cs, "alpha/Team/room.md", ownedChat)
		if code, body := cs.do(tok, http.MethodDelete, q, nil, ""); code != http.StatusOK {
			t.Errorf("%s could not delete the chat: %d %s", name, code, body)
		}
		if cs.exists("alpha/Team/room.md") {
			t.Errorf("%s: chat still there", name)
		}
	}
	// And the owner may delete the folder holding it.
	writeFixture(t, cs, "alpha/Team/room.md", ownedChat)
	if code, body := cs.do(owner, http.MethodDelete, "/api/note?ns=alpha&path=Team", nil, ""); code != http.StatusOK {
		t.Errorf("owner could not delete the folder: %d %s", code, body)
	}
}

func TestChatDelete_NoBackDoors(t *testing.T) {
	cs := newChatServer(t)
	owner := jwtFor(t, uidOwen, "collaborator", nil)
	writer := jwtFor(t, uidNate, "collaborator", nil)
	writeFixture(t, cs, "alpha/Team/room.md", ownedChat)
	q := "/api/note?ns=alpha&path=Team/room.md"

	// Stripping the chat marker, or the owner line, then deleting it as a
	// plain note.
	for name, content := range map[string]string{
		"no marker":       "---\ntitle: Owned\nowner: user3\n---\n\nhello\n",
		"no front matter": "hello\n",
		"new owner":       strings.Replace(ownedChat, "owner: user3", "owner: user6", 1),
		"owner removed":   strings.Replace(ownedChat, "owner: user3\n", "", 1),
	} {
		if code, body := cs.do(writer, http.MethodPut, q, strings.NewReader(content), ""); code != http.StatusForbidden {
			t.Errorf("PUT %s by a non-owner: %d %s", name, code, body)
		}
	}
	// Text above the front matter makes it a plain note too.
	if code, body := cs.do(writer, http.MethodPatch, q+"&position=top", strings.NewReader("junk"), ""); code != http.StatusForbidden {
		t.Errorf("prepend by a non-owner: %d %s", code, body)
	}
	// An upload of the same name replaces the file.
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "room.md")
	fw.Write([]byte("replaced\n"))
	mw.Close()
	if code, body := cs.do(writer, http.MethodPost, "/api/upload?ns=alpha&path="+url.QueryEscape("Team/x.png"), &buf, mw.FormDataContentType()); code != http.StatusForbidden {
		t.Errorf("upload over a chat by a non-owner: %d %s", code, body)
	}
	data, _ := os.ReadFile(filepath.Join(cs.root, "alpha/Team/room.md"))
	if string(data) != ownedChat {
		t.Fatalf("chat changed by a refused request:\n%s", data)
	}

	// Ordinary edits by any writer still work: the messages, the title, an
	// append at the bottom.
	edited := strings.Replace(ownedChat, "title: Owned", "title: Renamed", 1) + "\n#### user6 · 2026-10-07T10:01:00Z\nmore\n"
	if code, body := cs.do(writer, http.MethodPut, q, strings.NewReader(edited), ""); code != http.StatusOK {
		t.Errorf("ordinary edit by a writer: %d %s", code, body)
	}
	if code, body := cs.do(writer, http.MethodPatch, q, strings.NewReader("a line"), ""); code != http.StatusOK {
		t.Errorf("append by a writer: %d %s", code, body)
	}
	// The owner may turn it back into a plain note.
	if code, body := cs.do(owner, http.MethodPut, q, strings.NewReader("just a note\n"), ""); code != http.StatusOK {
		t.Errorf("owner un-chatting their chat: %d %s", code, body)
	}
}

// A chat created through the API records its creator; a chat made before
// owners existed is owned by the account of its first message.
func TestChatOwner_StampedOnCreateAndInferredForOldChats(t *testing.T) {
	cs := newChatServer(t)
	creator := jwtFor(t, uidMia, "collaborator", nil) // user5
	other := jwtFor(t, uidNate, "collaborator", nil)
	if code, body := cs.do(creator, http.MethodPost, "/api/chat/convert?ns=alpha&path=Chats/new.md&title=New", nil, ""); code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	data, _ := os.ReadFile(filepath.Join(cs.root, "alpha/Chats/new.md"))
	if !strings.Contains(string(data), "\nowner: user5\n") {
		t.Fatalf("owner not recorded:\n%s", data)
	}
	if code, _ := cs.do(other, http.MethodDelete, "/api/note?ns=alpha&path=Chats/new.md", nil, ""); code != http.StatusForbidden {
		t.Errorf("non-owner deleted a new chat: %d", code)
	}

	// Older chat, first message by user6 (via an agent label): user6 owns it.
	writeFixture(t, cs, "alpha/Old/legacy.md", "---\nmdnest-chat: true\n---\n\n#### helper (via user6) · 2026-10-07T10:00:00Z\nhi\n")
	if code, _ := cs.do(creator, http.MethodDelete, "/api/note?ns=alpha&path=Old/legacy.md", nil, ""); code != http.StatusForbidden {
		t.Errorf("non-owner deleted a legacy chat: %d", code)
	}
	if code, body := cs.do(other, http.MethodDelete, "/api/note?ns=alpha&path=Old/legacy.md", nil, ""); code != http.StatusOK {
		t.Errorf("first poster could not delete a legacy chat: %d %s", code, body)
	}
	// An old chat with no messages has nothing to lose: any writer may.
	writeFixture(t, cs, "alpha/Old/empty.md", "---\nmdnest-chat: true\n---\n")
	if code, body := cs.do(creator, http.MethodDelete, "/api/note?ns=alpha&path=Old/empty.md", nil, ""); code != http.StatusOK {
		t.Errorf("empty legacy chat: %d %s", code, body)
	}
}
