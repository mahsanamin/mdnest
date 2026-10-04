package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mdnest/mdnest/backend/store"
)

// pathGrants is a GrantStore whose CheckAccess IS the Postgres rule
// (store.GrantsAllow over GetGrantsForUser), so CheckRead and ReadFilter can
// be compared on the same grants.
type pathGrants struct {
	fakeGrantStore
	grants []store.Grant
}

func (p *pathGrants) GetGrantsForUser(uid int) ([]store.Grant, error) {
	var out []store.Grant
	for _, g := range p.grants {
		if g.UserID == uid {
			out = append(out, g)
		}
	}
	return out, nil
}

func (p *pathGrants) CheckAccess(uid int, ns, path, perm string) bool {
	gs, _ := p.GetGrantsForUser(uid)
	return store.GrantsAllow(gs, ns, path, perm)
}

// The per-request filter must agree with CheckRead on every path: it exists
// only to avoid two queries per file, never to apply a different rule.
func TestReadFilterAgreesWithCheckRead(t *testing.T) {
	gs := &pathGrants{grants: []store.Grant{
		{UserID: 1, Namespace: "alpha", Path: "/Shared", Permission: "read"},
		{UserID: 1, Namespace: "alpha", Path: "/Docs/one.md", Permission: "write"},
		{UserID: 2, Namespace: "alpha", Path: "/", Permission: "read"},
	}}
	pc := NewPermissionChecker(gs, fakeNsAdminStore{}, nil)
	paths := []string{"Shared/a.md", "Shared", "SharedX/a.md", "Private/p.md", "Docs/one.md", "Docs/two.md",
		"Shared/../Private/p.md", "../x", "", "Shared/sub/deep.md"}
	for _, uid := range []int{1, 2, 3} {
		r := WithUser(httptest.NewRequest(http.MethodGet, "/", nil), &UserContext{ID: uid})
		filter := pc.ReadFilter(r, "alpha")
		for _, p := range paths {
			canon, ok := canonicalPath(p)
			want := ok && pc.CheckRead(r, "alpha", canon)
			if got := filter(p); got != want {
				t.Errorf("user %d path %q: ReadFilter=%v CheckRead=%v", uid, p, got, want)
			}
		}
	}
}

// A listing that forgets to attach the checker in multi mode serves nothing;
// single mode (no user) still reads everything.
func TestReadFilterForFailsClosed(t *testing.T) {
	r := WithUser(httptest.NewRequest(http.MethodGet, "/", nil), &UserContext{ID: 1})
	if ReadFilterFor(r, "alpha")("Shared/a.md") {
		t.Fatal("a multi-mode request without a checker was allowed to read")
	}
	if !ReadFilterFor(httptest.NewRequest(http.MethodGet, "/", nil), "alpha")("Shared/a.md") {
		t.Fatal("single mode lost read access")
	}
}
