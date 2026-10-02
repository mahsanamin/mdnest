package store

import "testing"

// PathCovers is the single matching rule behind both per-user grants and
// group grants. Callers are expected to pass a canonical path; as defence in
// depth it also refuses a request path that still carries "." or ".."
// segments, so a caller that forgets to clean cannot be walked out of a grant.
func TestPathCovers(t *testing.T) {
	cases := []struct {
		grant, req string
		want       bool
	}{
		{"/", "/", true},
		{"/", "/anything/at/all.md", true},
		{"/Shared", "/Shared", true},
		{"/Shared", "/Shared/x.md", true},
		{"/Shared", "/Shared/sub/y.md", true},
		{"/Shared", "/SharedX/y.md", false},
		{"/Shared", "/Private/x.md", false},
		{"/Shared", "/", false},

		// Non-canonical request paths are never covered.
		{"/Shared", "/Shared/../Private/x.md", false},
		{"/Shared", "/Shared/sub/../../Private/x.md", false},
		{"/Shared", "/Shared/./x.md", false},
		{"/Shared", "/Shared/..", false},
		{"/", "/../etc/passwd", false},
		{"/", "/Shared/../Private/x.md", false},

		// A ".." inside a name is not a segment and stays allowed.
		{"/Shared", "/Shared/notes..md", true},
		{"/Shared", "/Shared/..hidden/x.md", true},
	}
	for _, c := range cases {
		if got := PathCovers(c.grant, c.req); got != c.want {
			t.Errorf("PathCovers(%q, %q) = %v, want %v", c.grant, c.req, got, c.want)
		}
	}
}
