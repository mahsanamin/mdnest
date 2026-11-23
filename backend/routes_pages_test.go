package main

// HTML pages through the real route table and auth middleware: the flag off
// registers nothing, and access to a page follows its handle file's folder,
// with the notes' own grants.

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
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

func q(p string) string { return url.QueryEscape(p) }

func TestRoutes_PagesOffRegistersNothing(t *testing.T) {
	for _, multi := range []bool{false, true} {
		ts := newTestServer(t, multi)
		tok := jwtFor(t, uidOwen, "collaborator", nil)
		for _, p := range []string{"/api/pages?ns=alpha", "/api/pages/text?ns=alpha&path=x.page.md", "/api/pages/archive?ns=alpha&path=x.page.md", "/api/pages/view/x/"} {
			if code, _ := ts.get(tok, p); code != http.StatusNotFound {
				t.Errorf("multi=%v: %s answered %d with pages off", multi, p, code)
			}
		}
		for _, p := range []string{"/api/pages/pass?ns=alpha&path=x.page.md"} {
			if code, _ := ts.do(tok, http.MethodPost, p, nil, ""); code != http.StatusNotFound {
				t.Errorf("multi=%v: %s answered %d with pages off", multi, p, code)
			}
		}
		if code, _ := ts.do(tok, http.MethodDelete, "/api/pages/unlinked?ns=alpha&id=x", nil, ""); code != http.StatusNotFound {
			t.Errorf("multi=%v: unlinked delete answered %d with pages off", multi, code)
		}
		// A *.page.md is an ordinary note: created, read and deleted as one.
		body := "---\npage: abcdefghijklmnopqrstuvwxyz234567\n---\n\nHTML page, open it in mdnest.\n"
		if code, b := ts.do(tok, http.MethodPost, "/api/note?ns=alpha&path=Shared/off.page.md", strings.NewReader(body), ""); code >= 300 {
			t.Fatalf("multi=%v: create a .page.md with pages off: %d %s", multi, code, b)
		}
		if code, b := ts.get(tok, "/api/note?ns=alpha&path=Shared/off.page.md"); code != 200 || !strings.Contains(b, "HTML page, open it in mdnest.") {
			t.Fatalf("multi=%v: read a .page.md with pages off: %d %s", multi, code, b)
		}
		if code, _ := ts.do(tok, http.MethodDelete, "/api/note?ns=alpha&path=Shared/off.page.md", nil, ""); code != 200 {
			t.Fatalf("multi=%v: delete a .page.md with pages off: %d", multi, code)
		}
	}
}

type passResp struct {
	URL   string
	Title string
}

func TestRoutes_PageAccessFollowsTheHandleFolder(t *testing.T) {
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

	publish := func(tok, p, body string) (int, string) {
		return ts.do(tok, http.MethodPut, "/api/pages?ns=alpha&path="+q(p), strings.NewReader(body), "text/html")
	}
	pass := func(tok, p string) (int, string) {
		return ts.do(tok, http.MethodPost, "/api/pages/pass?ns=alpha&path="+q(p), nil, "")
	}

	if code, body := publish(owen, "Shared/team.page.md", "<title>Team</title><p>SHARED-BODY</p>"); code != 200 {
		t.Fatalf("namespace writer publish: %d %s", code, body)
	}
	if code, body := publish(owen, "Private/boss.page.md", "<title>Boss</title><p>PRIVATE-BODY</p>"); code != 200 {
		t.Fatalf("namespace writer publish: %d %s", code, body)
	}

	// A subfolder writer publishes in that folder, and nowhere else.
	if code, body := publish(pat, "Shared/patsfirst.page.md", "<p>PAT</p>"); code != 200 {
		t.Fatalf("folder writer publish in the folder: %d %s", code, body)
	}
	for name, tok := range map[string]string{"pat(folder write)": pat, "gus(folder read)": gus, "rita(read)": rita, "adele": adele, "superadmin": super} {
		if code, _ := publish(tok, "Private/x.page.md", "<p>x</p>"); code != http.StatusForbidden {
			t.Errorf("%s publish in Private: %d, want 403", name, code)
		}
		if code, _ := ts.do(tok, http.MethodDelete, "/api/pages?ns=alpha&path="+q("Private/boss.page.md"), nil, ""); code != http.StatusForbidden {
			t.Errorf("%s delete in Private: %d, want 403", name, code)
		}
	}
	for name, tok := range map[string]string{"gus(folder read)": gus, "adele(folder read)": adele} {
		if code, _ := publish(tok, "Shared/x.page.md", "<p>x</p>"); code != http.StatusForbidden {
			t.Errorf("%s publish in Shared: %d, want 403", name, code)
		}
	}

	// Republishing makes a new id and only moves the handles the publisher
	// can write. A handle is readable, so its id is no secret from readers:
	// Wes (read everywhere, write Private) copies Pat's handle into Private.
	const uidWes = 6
	ts.grants.mu.Lock()
	ts.grants.grants = append(ts.grants.grants,
		store.Grant{UserID: uidWes, Namespace: "alpha", Path: "/", Permission: "read"},
		store.Grant{UserID: uidWes, Namespace: "alpha", Path: "/Private", Permission: "write"})
	ts.grants.mu.Unlock()
	wes := jwtFor(t, uidWes, "collaborator", nil)
	viewOf := func(tok, p string) string {
		code, body := pass(tok, p)
		if code != 200 {
			return "pass " + body
		}
		var pr passResp
		json.Unmarshal([]byte(body), &pr)
		_, b := ts.get("", pr.URL)
		return b
	}
	if code, b := publish(pat, "Shared/pats.page.md", "<p>PAT-V1</p>"); code != 200 {
		t.Fatalf("pat publish v1: %d %s", code, b)
	}
	_, patHandle := ts.get(pat, "/api/note?ns=alpha&path="+q("Shared/pats.page.md"))
	for _, p := range []string{"Private/forged.page.md"} {
		if code, b := ts.do(wes, http.MethodPost, "/api/note?ns=alpha&path="+q(p), strings.NewReader(patHandle), ""); code >= 300 {
			t.Fatalf("wes writes %s: %d %s", p, code, b)
		}
	}
	// A forged publish only moves the forger's own handle: Pat's page is
	// byte-identical afterwards.
	if code, b := publish(wes, "Private/forged.page.md", "<p>DEFACED</p>"); code != 200 {
		t.Fatalf("wes publishes through the forged handle: %d %s", code, b)
	}
	if got := viewOf(pat, "Shared/pats.page.md"); got != "<p>PAT-V1</p>" {
		t.Fatalf("Pat's page after the forged publish: %q", got)
	}
	// Wes saves a copy of Pat's handle (v1) in a folder Pat cannot write.
	if code, b := ts.do(wes, http.MethodPost, "/api/note?ns=alpha&path="+q("Private/saved.page.md"), strings.NewReader(patHandle), ""); code >= 300 {
		t.Fatalf("wes saves a copy: %d %s", code, b)
	}
	// The forged handle does not block Pat: Pat republishes, and Pat's handle
	// moves to v2. Wes's saved copy (Pat cannot write Private) keeps showing
	// the v1 snapshot, never v2.
	if code, b := publish(pat, "Shared/pats.page.md", "<p>PAT-V2</p>"); code != 200 {
		t.Fatalf("pat republishes with a forged handle around: %d %s", code, b)
	}
	if got := viewOf(gus, "Shared/pats.page.md"); got != "<p>PAT-V2</p>" {
		t.Fatalf("Pat's page after republish: %q", got)
	}
	if got := viewOf(wes, "Private/saved.page.md"); got != "<p>PAT-V1</p>" {
		t.Fatalf("a saved old id shows %q, want only the old snapshot", got)
	}
	// The v1 snapshot goes once no handle names it.
	if code, _ := ts.do(wes, http.MethodDelete, "/api/note?ns=alpha&path="+q("Private/saved.page.md"), nil, ""); code != 200 {
		t.Fatalf("delete the saved copy: %d", code)
	}
	ts.do(wes, http.MethodDelete, "/api/note?ns=alpha&path="+q("Private/forged.page.md"), nil, "")
	if _, b := ts.get(owen, "/api/pages?ns=alpha"); strings.Contains(b, "PAT-V1") || strings.Contains(b, `"unlinked":[{`) {
		t.Fatalf("old snapshot or forged page left behind: %s", b)
	}

	// Viewing follows the folder: a subfolder-only reader sees the page in
	// that folder and not the one in a sibling folder.
	for name, tok := range map[string]string{"pat": pat, "gus": gus, "adele": adele} {
		code, body := pass(tok, "Shared/team.page.md")
		if code != 200 {
			t.Fatalf("%s pass for Shared: %d %s", name, code, body)
		}
		var pr passResp
		json.Unmarshal([]byte(body), &pr)
		if c, b := ts.get("", pr.URL); c != 200 || !strings.Contains(b, "SHARED-BODY") {
			t.Fatalf("%s view Shared: %d %s", name, c, b)
		}
		if code, _ := pass(tok, "Private/boss.page.md"); code != http.StatusForbidden {
			t.Errorf("%s pass for Private: %d, want 403", name, code)
		}
		for _, p := range []string{"/api/pages/text?ns=alpha&path=" + q("Private/boss.page.md"), "/api/pages/archive?ns=alpha&path=" + q("Private/boss.page.md")} {
			if code, b := ts.get(tok, p); code != http.StatusForbidden || strings.Contains(b, "PRIVATE-BODY") {
				t.Errorf("%s GET %s: %d %s", name, p, code, b)
			}
		}
		// The list holds what they can read, and no unlinked section.
		code, b := ts.get(tok, "/api/pages?ns=alpha")
		if code != 200 || !strings.Contains(b, "Shared/team.page.md") || strings.Contains(b, "Boss") || strings.Contains(b, `"unlinked"`) {
			t.Errorf("%s list: %d %s", name, code, b)
		}
	}
	if code, b := ts.get(super, "/api/pages?ns=alpha"); code != 200 || strings.Contains(b, "Team") || strings.Contains(b, "Boss") {
		t.Errorf("superadmin with no grant listed pages: %d %s", code, b)
	}
	if code, _ := pass(super, "Shared/team.page.md"); code != http.StatusForbidden {
		t.Errorf("superadmin with no grant got a pass: %d", code)
	}
	if code, _ := ts.get("", "/api/pages?ns=alpha"); code != http.StatusUnauthorized {
		t.Errorf("no token list: %d", code)
	}

	// A reader of the whole namespace sees every page, not the unlinked list.
	if code, b := ts.get(rita, "/api/pages?ns=alpha"); code != 200 || !strings.Contains(b, "Team") || !strings.Contains(b, "Boss") || strings.Contains(b, `"unlinked"`) {
		t.Errorf("rita list: %d %s", code, b)
	}
	// The pass is not a session anywhere else.
	_, body := pass(rita, "Shared/team.page.md")
	var pr passResp
	json.Unmarshal([]byte(body), &pr)
	p := strings.TrimSuffix(strings.TrimPrefix(pr.URL, "/api/pages/view/"), "/")
	if code, _ := ts.get(p, "/api/tree?ns=alpha"); code != http.StatusUnauthorized {
		t.Errorf("pass used as a bearer token on the tree: %d", code)
	}

	// The handle is a note in the tree; the page files are not.
	if _, b := ts.get(owen, "/api/tree?ns=alpha"); !strings.Contains(b, "team.page.md") || strings.Contains(b, "index.html") {
		t.Errorf("tree: %s", b)
	}

	// Deleting the handle through the normal note route deletes the page;
	// a handle removed behind mdnest's back leaves it unlinked, listed only
	// for namespace-root writers.
	if code, _ := ts.do(owen, http.MethodDelete, "/api/note?ns=alpha&path="+q("Shared/patsfirst.page.md"), nil, ""); code != 200 {
		t.Fatalf("delete handle: %d", code)
	}
	os.Remove(filepath.Join(ts.root, "alpha", "Private", "boss.page.md"))
	_, b := ts.get(owen, "/api/pages?ns=alpha")
	var list struct {
		Pages    []handlers.PageMeta
		Unlinked []handlers.PageMeta
	}
	json.Unmarshal([]byte(b), &list)
	if len(list.Unlinked) != 1 || list.Unlinked[0].Title != "Boss" {
		t.Fatalf("root writer's unlinked list: %s", b)
	}
	if code, _ := ts.do(rita, http.MethodDelete, "/api/pages/unlinked?ns=alpha&id="+list.Unlinked[0].ID, nil, ""); code != http.StatusForbidden {
		t.Errorf("a reader deleted an unlinked page: %d", code)
	}
	if code, b := ts.do(owen, http.MethodDelete, "/api/pages/unlinked?ns=alpha&id="+list.Unlinked[0].ID, nil, ""); code != 200 {
		t.Errorf("root writer deletes the unlinked page: %d %s", code, b)
	}
}

func TestRoutes_PagesSingleMode(t *testing.T) {
	ts := newTestServer(t, false, withPages(t, ""))
	tok := jwtFor(t, 1, "", nil)
	if code, body := ts.do(tok, http.MethodPut, "/api/pages?ns=alpha&path=s.page.md", strings.NewReader("<p>SINGLE</p>"), "text/html"); code != 200 || !strings.Contains(body, `"author":"admin"`) {
		t.Fatalf("publish: %d %s", code, body)
	}
	if code, body := ts.get(tok, "/api/pages?ns=alpha"); code != 200 || !strings.Contains(body, `"path":"s.page.md"`) || !strings.Contains(body, `"unlinked":[]`) {
		t.Fatalf("list: %d %s", code, body)
	}
	if code, body := ts.get(tok, "/api/note?ns=alpha&path=s.page.md"); code != 200 || !strings.Contains(body, "page: ") {
		t.Fatalf("the handle reads as a note: %d %s", code, body)
	}
}

func TestRoutes_PagesScriptModeServesNoFilesOnTheMainOrigin(t *testing.T) {
	ts := newTestServer(t, false, withPages(t, "http://localhost:18081"))
	tok := jwtFor(t, 1, "", nil)
	ts.do(tok, http.MethodPut, "/api/pages?ns=alpha&path=s.page.md", strings.NewReader("<p>SCRIPTED</p>"), "text/html")
	code, body := ts.do(tok, http.MethodPost, "/api/pages/pass?ns=alpha&path=s.page.md", nil, "")
	if code != 200 || !strings.Contains(body, `"url":"http://localhost:18081/`) || !strings.Contains(body, `"scripts":true`) {
		t.Fatalf("pass: %d %s", code, body)
	}
	var pr passResp
	json.Unmarshal([]byte(body), &pr)
	p := strings.TrimPrefix(pr.URL, "http://localhost:18081/")
	if code, body := ts.get(tok, "/api/pages/view/"+p); code != http.StatusNotFound || strings.Contains(body, "SCRIPTED") {
		t.Fatalf("main origin served a scripted page: %d %s", code, body)
	}
}
