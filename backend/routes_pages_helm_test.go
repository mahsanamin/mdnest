package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/storage"
)

func TestRoutes_ChartPagesStoreIsNeverANamespace(t *testing.T) {
	for _, multi := range []bool{false, true} {
		ts := newTestServer(t, multi, withPages(t, ""))
		tok := jwtFor(t, uidOwen, "collaborator", nil)
		const hidden = ".mdnest-pages"
		const secret = "CHART-PAGE-FILES-PRIVATE"
		full := filepath.Join(ts.root, hidden, "alpha/id/index.html")
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(secret), 0644)
		// Verify the real discovery code, rather than assuming a dot folder is
		// hidden because .marp-themes happens to be a reserved application store.
		stg, err := storage.NewLocalStorage(ts.root)
		if err != nil {
			t.Fatal(err)
		}
		names, err := stg.ListNamespaces(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		for _, ns := range names {
			if ns == hidden {
				t.Fatal("private pages store discovered as a namespace")
			}
		}
		for _, query := range []string{"", "?detail=1", "?scope=manage", "?scope=manage&detail=1"} {
			_, body := ts.get(tok, "/api/namespaces"+query)
			if strings.Contains(body, hidden) {
				t.Fatalf("namespace listing leaked private store: %s", body)
			}
		}
		req := httptest.NewRequest("GET", "/api/note?ns="+hidden, nil)
		w := httptest.NewRecorder()
		if dir := handlers.RequireNamespace(ts.root, w, req); dir != "" || w.Code < 400 {
			t.Fatal("RequireNamespace accepted private store")
		}
		w = httptest.NewRecorder()
		if ns := handlers.RequireNamespaceStore(context.Background(), stg, w, req); ns != "" || w.Code < 400 {
			t.Fatal("RequireNamespaceStore accepted private store")
		}
		base := "?ns=" + hidden + "&path=alpha/id/index.html"
		for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE"} {
			code, body := ts.do(tok, method, "/api/note"+base, strings.NewReader("overwrite"), "")
			if code < 400 || code >= 500 || strings.Contains(body, secret) {
				t.Errorf("multi=%v %s note: %d %s", multi, method, code, body)
			}
		}
		routes := []struct{ method, path string }{
			{"GET", "/api/tree" + base}, {"GET", "/api/search" + base + "&q=" + secret}, {"GET", "/api/images" + base},
			{"GET", "/api/files/" + hidden + "/alpha/id/index.html"}, {"GET", "/api/download" + base},
			{"POST", "/api/folder" + base}, {"POST", "/api/move?ns=" + hidden + "&from=alpha/id/index.html&to=copied.html"},
			{"GET", "/api/note/history" + base}, {"GET", "/api/note/at" + base + "&ref=HEAD"},
			{"GET", "/api/pages?ns=" + hidden}, {"GET", "/api/pages/export?ns=" + hidden}, {"POST", "/api/pages/import?ns=" + hidden},
		}
		for _, route := range routes {
			code, body := ts.do(tok, route.method, route.path, strings.NewReader("overwrite"), "")
			if code < 400 || code >= 500 || strings.Contains(body, secret) {
				t.Errorf("multi=%v %s %s: %d %s", multi, route.method, route.path, code, body)
			}
		}
		for _, body := range []string{
			`{"mode":"copy","from":{"ns":".mdnest-pages","path":"alpha/id/index.html"},"to":{"ns":"alpha","path":"stolen.html"}}`,
			`{"mode":"copy","from":{"ns":"alpha","path":"Shared/a.md"},"to":{"ns":".mdnest-pages","path":"stolen.md"}}`,
		} {
			if code, _ := ts.do(tok, http.MethodPost, "/api/transfer", strings.NewReader(body), "application/json"); code < 400 {
				t.Fatal("transfer accepted private namespace")
			}
		}
		if data, _ := os.ReadFile(full); string(data) != secret {
			t.Fatal("a note endpoint changed private page files")
		}
	}
}
