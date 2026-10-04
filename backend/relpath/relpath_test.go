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

// .git and .mdnest are never request paths: a write into .git runs commands
// (core.fsmonitor, hooks) the next time git touches the tree, and .mdnest holds
// comment threads and board settings for the whole namespace. Matched per
// segment, case-insensitively (mounts can be case-insensitive), and ignoring
// what a case-insensitive or Windows-style filesystem would also ignore.
func TestCleanRefusesReservedSegments(t *testing.T) {
	for _, in := range []string{
		".git", ".git/config", ".GIT/config", ".Git/hooks/pre-commit", "Shared/.git/config",
		"Shared/../.git/config", ".git/", ".git.", ".git ", "git~1/config", ".g‌it/config",
		".mdnest", ".mdnest/comments/x.jsonl", ".MDNEST/board.json", "a/.mdnest/x",
	} {
		if got, valid := Clean(in); valid {
			t.Errorf("Clean(%q) = (%q, true), want rejection", in, got)
		}
	}
	for _, in := range []string{".gitkeep", ".gitignore", "a/.gitkeep", ".mdnest-sync-status.json", "git/x.md", ".github/x.md", "x.git", "my.mdnest.md"} {
		if _, valid := Clean(in); !valid {
			t.Errorf("Clean(%q) rejected an ordinary name", in)
		}
	}
}
