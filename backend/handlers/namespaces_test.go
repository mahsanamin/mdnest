package handlers

import (
	"reflect"
	"testing"
)

type fakePersonalLister struct{ ns []string }

func (f fakePersonalLister) PersonalNamespaces() ([]string, error) { return f.ns, nil }

// The management-plane namespace list must drop personal workspaces (the
// owner's own namespace, reported via PersonalNamespaces) while keeping team
// namespaces untouched.
func TestExcludePersonal(t *testing.T) {
	h := NewNamespaceHandler(nil, nil, fakePersonalLister{ns: []string{"olivier@forterro.com"}})
	got := h.excludePersonal([]string{
		"team-a",
		"olivier@forterro.com", // personal → drop
		"it-operations",
	})
	want := []string{"team-a", "it-operations"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("excludePersonal = %v, want %v", got, want)
	}
}

// With no personal lister (single mode) the list is returned unchanged.
func TestExcludePersonalNilLister(t *testing.T) {
	h := NewNamespaceHandler(nil, nil, nil)
	got := h.excludePersonal([]string{"team-a", "team-b"})
	want := []string{"team-a", "team-b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("excludePersonal = %v, want %v", got, want)
	}
}
