package main

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// These are the endpoint families used by the browser, CLI and MCP read_note.
// Public names that link into the private store must be refused in single mode
// too, where no permission middleware is installed.
func TestRoutes_PrivatePageFilesAreNeverNotes(t *testing.T) {
	for _, multi := range []bool{false, true} {
		t.Run(strconv.FormatBool(multi), func(t *testing.T) {
			ts := newTestServer(t, multi)
			tok := jwtFor(t, uidOwen, "collaborator", nil)
			const secret = "PRIVATE-PAGE-HTML-9821"
			rel := ".mdnest/pages/abcdefghijklmnopqrstuvwxyz234567/index.html"
			full := filepath.Join(ts.root, "alpha", rel)
			os.MkdirAll(filepath.Dir(full), 0755)
			os.WriteFile(full, []byte(secret), 0644)
			os.Symlink("../"+rel, filepath.Join(ts.root, "alpha", "Shared", "page-link.md"))
			for _, p := range []string{rel, "Shared/page-link.md"} {
				qp := url.QueryEscape(p)
				for _, ep := range []string{"/api/note?ns=alpha&path=" + qp, "/api/files/alpha/" + p, "/api/download?ns=alpha&path=" + qp} {
					code, body := ts.get(tok, ep)
					if code < 400 || strings.Contains(body, secret) {
						t.Errorf("read %s: %d %s", ep, code, body)
					}
				}
				for _, method := range []string{http.MethodPut, http.MethodPost, http.MethodPatch, http.MethodDelete} {
					code, _ := ts.do(tok, method, "/api/note?ns=alpha&path="+qp, strings.NewReader("overwrite"), "")
					if code < 400 {
						t.Errorf("%s note %s: %d", method, p, code)
					}
				}
				for _, dst := range []bool{false, true} {
					from, to := p, "Shared/copied-page.md"
					if dst {
						from, to = "Shared/a.md", p
					}
					body := `{"mode":"copy","from":{"ns":"alpha","path":` + strconv.Quote(from) + `},"to":{"ns":"alpha","path":` + strconv.Quote(to) + `}}`
					code, _ := ts.do(tok, http.MethodPost, "/api/transfer", strings.NewReader(body), "application/json")
					if code < 400 {
						t.Errorf("transfer %s: %d", body, code)
					}
				}
			}
			for _, ep := range []string{"/api/tree?ns=alpha", "/api/tree?ns=alpha&path=.mdnest/pages", "/api/search?ns=alpha&q=" + secret, "/api/images?ns=alpha"} {
				_, body := ts.get(tok, ep)
				if strings.Contains(body, secret) || strings.Contains(body, "index.html") || strings.Contains(body, ".mdnest/pages") {
					t.Errorf("listing %s leaked pages: %s", ep, body)
				}
			}
			code, body := ts.get(tok, "/api/download?ns=alpha")
			if code != 200 {
				t.Fatalf("download namespace: %d %s", code, body)
			}
			for name, data := range zipEntries(t, body) {
				if strings.Contains(name, ".mdnest/") || strings.Contains(data, secret) {
					t.Errorf("zip exposed page %s", name)
				}
			}
			if data, _ := os.ReadFile(full); string(data) != secret {
				t.Error("a refused endpoint changed private page")
			}
		})
	}
}
