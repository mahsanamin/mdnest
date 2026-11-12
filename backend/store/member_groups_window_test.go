package store

import (
	"testing"
	"time"
)

// The member list counts a person's recorded IdP groups for at least the
// default window, and for as long as their API tokens reach the namespace
// when API_TOKEN_GROUPS_MAX_AGE is longer. It never counts them forever.
func TestMemberGroupsWindow(t *testing.T) {
	cases := []struct {
		maxAge time.Duration
		want   time.Duration
	}{
		{0, DefaultMemberGroupsWindow},
		{time.Hour, DefaultMemberGroupsWindow},
		{168 * time.Hour, DefaultMemberGroupsWindow},
		{DefaultMemberGroupsWindow, DefaultMemberGroupsWindow},
		{90 * 24 * time.Hour, 90 * 24 * time.Hour},
	}
	for _, c := range cases {
		if got := MemberGroupsWindow(c.maxAge); got != c.want {
			t.Errorf("MemberGroupsWindow(%s) = %s, want %s", c.maxAge, got, c.want)
		}
	}
	if s := NewPostgresGrantStore(nil); s.memberGroupsWindow != DefaultMemberGroupsWindow {
		t.Errorf("a new store counts IdP groups for %s, want %s", s.memberGroupsWindow, DefaultMemberGroupsWindow)
	}
	s := NewPostgresGrantStore(nil)
	s.UseTokenGroupsMaxAge(90 * 24 * time.Hour)
	if s.memberGroupsWindow != 90*24*time.Hour {
		t.Errorf("a longer token age did not widen the window: %s", s.memberGroupsWindow)
	}
}
