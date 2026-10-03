package relpath

import "testing"

func TestClean(t *testing.T) {
	ok := map[string]string{
		"x.md":                   "x.md",
		"Shared/x.md":            "Shared/x.md",
		"Shared/../Private/x.md": "Private/x.md",
		"Shared/./sub//y.md":     "Shared/sub/y.md",
		"Shared/":                "Shared",
	}
	for in, want := range ok {
		if got, valid := Clean(in); !valid || got != want {
			t.Errorf("Clean(%q) = (%q, %v), want (%q, true)", in, got, valid, want)
		}
	}
	for _, in := range []string{"", ".", "/", "/etc/passwd", "..", "../x.md", "Shared/../../x.md"} {
		if got, valid := Clean(in); valid {
			t.Errorf("Clean(%q) = (%q, true), want rejection", in, got)
		}
	}
}
