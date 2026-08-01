package store

import "testing"

func TestGroupRepoURL(t *testing.T) {
	cases := map[string]string{
		"https://gitlab.forterro.com/mdnest-workspaces/dev":  "https://gitlab.forterro.com/mdnest-workspaces/dev/team-a.git",
		"https://gitlab.forterro.com/mdnest-workspaces/dev/": "https://gitlab.forterro.com/mdnest-workspaces/dev/team-a.git",
		"git@gitlab.forterro.com:mdnest-workspaces/dev":      "git@gitlab.forterro.com:mdnest-workspaces/dev/team-a.git",
	}
	for base, want := range cases {
		if got := groupRepoURL(base, "team-a"); got != want {
			t.Errorf("groupRepoURL(%q) = %q, want %q", base, got, want)
		}
	}
}
