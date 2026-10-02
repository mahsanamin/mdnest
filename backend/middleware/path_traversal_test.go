package middleware

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/store"
)

// The permission wrappers used to check the path exactly as the client sent
// it, while every handler acts on the lexically cleaned path. A grant on
// /Shared therefore approved "Shared/../Private/x.md" (it has the prefix
// "/Shared/"), and the handler then read, wrote or deleted Private/x.md. These
// tests pin that the check runs on the same canonical path the handler uses.

type pathGrant struct {
	namespace, path, permission string
}

// pathGrantStore is a path-aware fake that matches grants with the real
// store.PathCovers, normalising the request path the way PostgresGrantStore
// does. The other fake in this package ignores paths, which is exactly why it
// could never have caught this.
type pathGrantStore struct {
	fakeGrantStore
	grants map[int][]pathGrant
}

func (f *pathGrantStore) CheckAccess(userID int, namespace, path, requiredPermission string) bool {
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	for _, g := range f.grants[userID] {
		if g.namespace != namespace || !store.PathCovers(g.path, path) {
			continue
		}
		if requiredPermission == "read" || g.permission == "write" {
			return true
		}
	}
	return false
}

const (
	sharedUser = 10 // write grant on /Shared only
	rootUser   = 11 // write grant on / (the whole namespace)
)

func newPathChecker() *PermissionChecker {
	gs := &pathGrantStore{grants: map[int][]pathGrant{
		sharedUser: {{"ws", "/Shared", "write"}},
		rootUser:   {{"ws", "/", "write"}},
	}}
	return NewPermissionChecker(gs, fakeNsAdminStore{}, nil)
}

// wrapped runs one request through a wrapper and reports whether the inner
// handler was reached, plus the status the client saw.
func wrapped(wrap func(http.Handler) http.Handler, method string, q url.Values, userID int) (bool, int) {
	reached := false
	h := wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))
	r := httptest.NewRequest(method, "/api/x?"+q.Encode(), nil)
	r = WithUser(r, &UserContext{ID: userID, Username: "u", Role: "collaborator"})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return reached, w.Code
}

type wrapCase struct {
	name   string
	wrap   func(*PermissionChecker) func(http.Handler) http.Handler
	method string
}

func pathWrappers() []wrapCase {
	return []wrapCase{
		{"RequireRead", func(pc *PermissionChecker) func(http.Handler) http.Handler { return pc.RequireRead }, "GET"},
		{"RequireWrite", func(pc *PermissionChecker) func(http.Handler) http.Handler { return pc.RequireWrite }, "POST"},
		{"ReadWriteRouter GET", func(pc *PermissionChecker) func(http.Handler) http.Handler { return pc.ReadWriteRouter }, "GET"},
		{"ReadWriteRouter PUT", func(pc *PermissionChecker) func(http.Handler) http.Handler { return pc.ReadWriteRouter }, "PUT"},
		{"ReadWriteRouter DELETE", func(pc *PermissionChecker) func(http.Handler) http.Handler { return pc.ReadWriteRouter }, "DELETE"},
	}
}

func TestPathWrappersRefuseTraversalOutOfGrant(t *testing.T) {
	pc := newPathChecker()
	escapes := []string{
		"Shared/../Private/x.md",
		"Shared/sub/../../Private/x.md",
		"Shared/./../Private/x.md",
		"Shared/..",
	}
	for _, wc := range pathWrappers() {
		for _, p := range escapes {
			reached, code := wrapped(wc.wrap(pc), wc.method, url.Values{"ns": {"ws"}, "path": {p}}, sharedUser)
			if reached {
				t.Errorf("%s: %q reached the handler with only a /Shared grant (status %d)", wc.name, p, code)
			}
			if code != http.StatusForbidden && code != http.StatusBadRequest {
				t.Errorf("%s: %q: want 403/400, got %d", wc.name, p, code)
			}
		}
	}
}

func TestPathWrappersStillAllowPathsInsideGrant(t *testing.T) {
	pc := newPathChecker()
	inside := []string{"Shared", "Shared/x.md", "Shared/sub/y.md", "Shared/sub/../y.md"}
	for _, wc := range pathWrappers() {
		for _, p := range inside {
			if reached, code := wrapped(wc.wrap(pc), wc.method, url.Values{"ns": {"ws"}, "path": {p}}, sharedUser); !reached {
				t.Errorf("%s: %q denied (status %d) although it is inside the /Shared grant", wc.name, p, code)
			}
		}
		// A sibling whose name merely starts with "Shared" is not covered.
		if reached, _ := wrapped(wc.wrap(pc), wc.method, url.Values{"ns": {"ws"}, "path": {"SharedX/y.md"}}, sharedUser); reached {
			t.Errorf("%s: SharedX/y.md allowed by a /Shared grant", wc.name)
		}
	}
}

func TestRootGrantStillCoversEverything(t *testing.T) {
	pc := newPathChecker()
	for _, wc := range pathWrappers() {
		for _, p := range []string{"", "Private/x.md", "Shared/x.md", "Shared/../Private/x.md", "a/b/c/d.md"} {
			if reached, code := wrapped(wc.wrap(pc), wc.method, url.Values{"ns": {"ws"}, "path": {p}}, rootUser); !reached {
				t.Errorf("%s: %q denied (status %d) for a / grant", wc.name, p, code)
			}
		}
	}
}

// A path that leaves the namespace (or is absolute) is refused outright,
// even for a root grant: there is no canonical in-namespace path to check.
func TestPathWrappersRejectPathsOutsideNamespace(t *testing.T) {
	pc := newPathChecker()
	for _, wc := range pathWrappers() {
		for _, p := range []string{"../other/x.md", "Shared/../../other/x.md", "/etc/passwd"} {
			reached, code := wrapped(wc.wrap(pc), wc.method, url.Values{"ns": {"ws"}, "path": {p}}, rootUser)
			if reached || code != http.StatusBadRequest {
				t.Errorf("%s: %q: want 400 before the handler, got reached=%v status=%d", wc.name, p, reached, code)
			}
		}
	}
}

func TestRequireMoveChecksCanonicalPaths(t *testing.T) {
	pc := newPathChecker()
	move := func(from, to string, user int) bool {
		reached, _ := wrapped(pc.RequireMove, "POST", url.Values{"ns": {"ws"}, "from": {from}, "to": {to}}, user)
		return reached
	}
	if !move("Shared/a.md", "Shared/sub/a.md", sharedUser) {
		t.Error("move inside the /Shared grant was denied")
	}
	if move("Shared/a.md", "Shared/../Private/a.md", sharedUser) {
		t.Error("move OUT of the grant via a traversal destination was allowed")
	}
	if move("Shared/../Private/a.md", "Shared/a.md", sharedUser) {
		t.Error("move INTO the grant from a traversal source was allowed")
	}
	if move("Shared/a.md", "../other/a.md", rootUser) {
		t.Error("move to a destination outside the namespace was allowed")
	}
	if !move("Private/a.md", "Shared/a.md", rootUser) {
		t.Error("root grant denied an ordinary move")
	}
}
