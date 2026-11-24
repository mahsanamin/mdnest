package main

import (
	"net/http"
	"strings"
	"testing"
)

func TestRoutes_PageBackupRequiresWholeNamespaceWrite(t *testing.T) {
	ts := newTestServer(t, true, withPages(t, ""))
	owner := jwtFor(t, uidOwen, "collaborator", nil)
	code, body := ts.get(owner, "/api/pages/export?ns=alpha")
	if code != 200 {
		t.Fatalf("namespace writer export: %d %s", code, body)
	}
	for _, uid := range []int{uidPat, uidGus, uidAdele, 99} {
		tok := jwtFor(t, uid, "superadmin", nil)
		if code, _ := ts.get(tok, "/api/pages/export?ns=alpha"); code != 403 {
			t.Errorf("uid %d export: %d", uid, code)
		}
		if code, _ := ts.do(tok, http.MethodPost, "/api/pages/import?ns=alpha", strings.NewReader("bad archive"), "application/gzip"); code != 403 {
			t.Errorf("uid %d import: %d", uid, code)
		}
	}
	for _, uid := range []int{uidOwen, uidPat} {
		token, _, err := ts.tokens.CreateAPIToken("backup", uid, "collaborator", "")
		if err != nil {
			t.Fatal(err)
		}
		code, _ := ts.get(token, "/api/pages/export?ns=alpha")
		want := 403
		if uid == uidOwen {
			want = 200
		}
		if code != want {
			t.Errorf("API token uid %d export: %d", uid, code)
		}
	}
	for _, ep := range []string{"/api/pages/export?ns=alpha", "/api/pages/import?ns=alpha"} {
		if code, _ := ts.do("", http.MethodPost, ep, nil, ""); code != 401 {
			t.Errorf("unauthenticated %s: %d", ep, code)
		}
	}
}
