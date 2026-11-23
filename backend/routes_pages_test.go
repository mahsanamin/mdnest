package main

// HTML pages through the real route table and auth middleware: the flag off
// registers nothing, and the page permission is the namespace root's.

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

const uidRita = 5 // read on alpha:/ (the whole namespace)

func withPages(t *testing.T, origin string) testServerOption {
	dir := t.TempDir()
	return func(r *contentRoutes, stg storage.Storage, perms *middleware.PermissionChecker) {
		r.pages = handlers.NewPagesHandler(handlers.PagesConfig{
			Dir:            dir,
			MaxBytes:       1 << 20,
			MaxFiles:       50,
			Origin:         origin,
			FrameAncestors: "http://localhost:5173",
			Secret:         []byte(testSecret),
			SingleUser:     "admin",
		}, stg, perms)
	}
}

func TestRoutes_PagesOffRegistersNothing(t *testing.T) {
	for _, multi := range []bool{false, true} {
		ts := newTestServer(t, multi)
		tok := jwtFor(t, uidOwen, "collaborator", nil)
		for _, p := range []string{"/api/pages?ns=alpha", "/api/pages/text?ns=alpha&slug=x", "/api/pages/archive?ns=alpha&slug=x", "/api/pages/view/x/"} {
			if code, _ := ts.get(tok, p); code != http.StatusNotFound {
				t.Errorf("multi=%v: %s answered %d with pages off", multi, p, code)
			}
		}
		if code, _ := ts.do(tok, http.MethodPost, "/api/pages/pass?ns=alpha&slug=x", nil, ""); code != http.StatusNotFound {
			t.Errorf("multi=%v: pass answered %d with pages off", multi, code)
		}
	}
}

func TestRoutes_PagesUseTheNamespaceRootPermission(t *testing.T) {
	ts := newTestServer(t, true, withPages(t, ""))
	ts.grants.mu.Lock()
	ts.grants.grants = append(ts.grants.grants, store.Grant{UserID: uidRita, Namespace: "alpha", Path: "/", Permission: "read"})
	ts.grants.mu.Unlock()

	owen := jwtFor(t, uidOwen, "collaborator", nil) // write on alpha:/
	rita := jwtFor(t, uidRita, "collaborator", nil) // read on alpha:/
	pat := jwtFor(t, uidPat, "collaborator", nil)   // write on alpha:/Shared only
	gus := jwtFor(t, uidGus, "collaborator", nil)   // group read on alpha:/Shared only
	adele := jwtFor(t, uidAdele, "admin", nil)      // admin of beta, read alpha:/Shared
	super := jwtFor(t, 99, "superadmin", nil)       // no grants: no content access
	html := strings.NewReader("<title>Board</title><p>PAGE-BODY</p>")

	if code, body := ts.do(owen, http.MethodPut, "/api/pages?ns=alpha&slug=board", html, "text/html"); code != 200 {
		t.Fatalf("namespace writer publish: %d %s", code, body)
	}
	for name, tok := range map[string]string{"rita(read)": rita, "pat(folder write)": pat, "gus(folder read)": gus, "adele": adele, "superadmin": super} {
		if code, _ := ts.do(tok, http.MethodPut, "/api/pages?ns=alpha&slug=x", strings.NewReader("<p>x</p>"), "text/html"); code != http.StatusForbidden {
			t.Errorf("%s publish: %d, want 403", name, code)
		}
		if code, _ := ts.do(tok, http.MethodDelete, "/api/pages?ns=alpha&slug=board", nil, ""); code != http.StatusForbidden {
			t.Errorf("%s delete: %d, want 403", name, code)
		}
	}
	// A grant on a subfolder does not give access to pages.
	for name, tok := range map[string]string{"pat(folder write)": pat, "gus(folder read)": gus, "adele": adele, "superadmin": super} {
		for _, p := range []string{"/api/pages?ns=alpha", "/api/pages/text?ns=alpha&slug=board", "/api/pages/archive?ns=alpha&slug=board"} {
			if code, body := ts.get(tok, p); code != http.StatusForbidden || strings.Contains(body, "PAGE-BODY") || strings.Contains(body, "Board") {
				t.Errorf("%s GET %s: %d %s", name, p, code, body)
			}
		}
		if code, _ := ts.do(tok, http.MethodPost, "/api/pages/pass?ns=alpha&slug=board", nil, ""); code != http.StatusForbidden {
			t.Errorf("%s pass: %d, want 403", name, code)
		}
	}
	if code, _ := ts.get("", "/api/pages?ns=alpha"); code != http.StatusUnauthorized {
		t.Errorf("no token list: %d", code)
	}

	// A namespace reader lists, reads the text and opens the page.
	code, body := ts.get(rita, "/api/pages?ns=alpha")
	if code != 200 || !strings.Contains(body, `"title":"Board"`) {
		t.Fatalf("reader list: %d %s", code, body)
	}
	if code, body := ts.get(rita, "/api/pages/text?ns=alpha&slug=board"); code != 200 || !strings.Contains(body, "PAGE-BODY") {
		t.Fatalf("reader text: %d %s", code, body)
	}
	code, body = ts.do(rita, http.MethodPost, "/api/pages/pass?ns=alpha&slug=board", nil, "")
	if code != 200 {
		t.Fatalf("reader pass: %d %s", code, body)
	}
	var pass struct{ URL string }
	json.Unmarshal([]byte(body), &pass)
	// The frame URL works with no session at all: the pass is the credential.
	if code, body := ts.get("", pass.URL); code != 200 || !strings.Contains(body, "PAGE-BODY") {
		t.Fatalf("view: %d %s", code, body)
	}
	// ...and the pass is not a session anywhere else.
	p := strings.TrimSuffix(strings.TrimPrefix(pass.URL, "/api/pages/view/"), "/")
	if code, _ := ts.get(p, "/api/pages?ns=alpha"); code != http.StatusUnauthorized {
		t.Errorf("pass used as a bearer token: %d", code)
	}
	if code, _ := ts.get(p, "/api/tree?ns=alpha"); code != http.StatusUnauthorized {
		t.Errorf("pass used as a bearer token on the tree: %d", code)
	}

	// Pages never appear in the notes tree or search.
	if _, body := ts.get(owen, "/api/tree?ns=alpha"); strings.Contains(body, "board") {
		t.Errorf("page showed in the notes tree: %s", body)
	}
	if _, body := ts.get(owen, "/api/search?ns=alpha&q=PAGE-BODY"); strings.Contains(body, "PAGE-BODY") {
		t.Errorf("page showed in notes search: %s", body)
	}
}

func TestRoutes_PagesSingleMode(t *testing.T) {
	ts := newTestServer(t, false, withPages(t, ""))
	tok := jwtFor(t, 1, "", nil)
	if code, body := ts.do(tok, http.MethodPut, "/api/pages?ns=alpha&slug=s", strings.NewReader("<p>SINGLE</p>"), "text/html"); code != 200 || !strings.Contains(body, `"author":"admin"`) {
		t.Fatalf("publish: %d %s", code, body)
	}
	if code, body := ts.get(tok, "/api/pages?ns=alpha"); code != 200 || !strings.Contains(body, `"slug":"s"`) {
		t.Fatalf("list: %d %s", code, body)
	}
}

func TestRoutes_PagesScriptModeServesNoFilesOnTheMainOrigin(t *testing.T) {
	ts := newTestServer(t, false, withPages(t, "http://localhost:18081"))
	tok := jwtFor(t, 1, "", nil)
	ts.do(tok, http.MethodPut, "/api/pages?ns=alpha&slug=s", strings.NewReader("<p>SCRIPTED</p>"), "text/html")
	code, body := ts.do(tok, http.MethodPost, "/api/pages/pass?ns=alpha&slug=s", nil, "")
	if code != 200 || !strings.Contains(body, `"url":"http://localhost:18081/`) || !strings.Contains(body, `"scripts":true`) {
		t.Fatalf("pass: %d %s", code, body)
	}
	var pass struct{ URL string }
	json.Unmarshal([]byte(body), &pass)
	p := strings.TrimPrefix(pass.URL, "http://localhost:18081/")
	if code, body := ts.get(tok, "/api/pages/view/"+p); code != http.StatusNotFound || strings.Contains(body, "SCRIPTED") {
		t.Fatalf("main origin served a scripted page: %d %s", code, body)
	}
}
