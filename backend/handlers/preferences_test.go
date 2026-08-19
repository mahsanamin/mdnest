package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/store"
)

func req(t *testing.T, method, body string, userID int) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/api/preferences", nil)
	} else {
		r = httptest.NewRequest(method, "/api/preferences", strings.NewReader(body))
	}
	r = middleware.WithUser(r, &middleware.UserContext{ID: userID, Username: "u", Role: "collaborator"})
	w := httptest.NewRecorder()
	NewPreferencesHandler(store.NewFilePreferenceStore(t.TempDir())).Handle(w, r)
	return w
}

// handlerOn builds a handler over one store so a test can make several calls
// against the same state.
func handlerOn(s store.PreferenceStore, method, body string, userID int) *httptest.ResponseRecorder {
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, "/api/preferences", nil)
	} else {
		r = httptest.NewRequest(method, "/api/preferences", strings.NewReader(body))
	}
	r = middleware.WithUser(r, &middleware.UserContext{ID: userID, Username: "u", Role: "collaborator"})
	w := httptest.NewRecorder()
	NewPreferencesHandler(s).Handle(w, r)
	return w
}

func TestPreferencesGetEmpty(t *testing.T) {
	w := req(t, http.MethodGet, "", 0)
	if w.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", w.Code)
	}
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("body is not a JSON object: %v (%s)", err, w.Body.String())
	}
	if len(got) != 0 {
		t.Fatalf("a user with no preferences should get {}, got %v", got)
	}
}

func TestPreferencesPatchRoundTrip(t *testing.T) {
	s := store.NewFilePreferenceStore(t.TempDir())

	w := handlerOn(s, http.MethodPatch, `{"theme":"light"}`, 0)
	if w.Code != http.StatusOK {
		t.Fatalf("PATCH got %d, want 200 (%s)", w.Code, w.Body.String())
	}
	// PATCH echoes the merged state back, so a client needs one round trip.
	var echoed map[string]string
	json.Unmarshal(w.Body.Bytes(), &echoed)
	if echoed["theme"] != "light" {
		t.Fatalf("PATCH should echo the stored value, got %v", echoed)
	}

	w = handlerOn(s, http.MethodGet, "", 0)
	var got map[string]string
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["theme"] != "light" {
		t.Fatalf("GET after PATCH: got %v, want theme=light", got)
	}
}

// Preferences are per-user. A shared store must not leak one user's theme to
// another — the multi-mode table is keyed the same way, so this pins the
// contract both backends implement.
func TestPreferencesAreScopedToTheUser(t *testing.T) {
	s := store.NewFilePreferenceStore(t.TempDir())
	handlerOn(s, http.MethodPatch, `{"theme":"light"}`, 1)

	w := handlerOn(s, http.MethodGet, "", 2)
	var got map[string]string
	json.Unmarshal(w.Body.Bytes(), &got)
	if _, ok := got["theme"]; ok {
		t.Fatalf("user 2 must not see user 1's preference, got %v", got)
	}
}

// The endpoint is writable by any authenticated user, so an unknown key is a
// 400 rather than a stored blob. Rejecting the whole request (not the bad key
// alone) keeps a 200 from meaning "some of what you sent was saved".
func TestPreferencesRejectsUnknownAndOversized(t *testing.T) {
	cases := map[string]string{
		"unknown key":     `{"wallpaper":"cats.png"}`,
		"oversized value": `{"theme":"` + strings.Repeat("x", store.MaxPreferenceValue+1) + `"}`,
		"empty object":    `{}`,
		"not an object":   `["theme"]`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			w := req(t, http.MethodPatch, body, 0)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("got %d, want 400 (%s)", w.Code, w.Body.String())
			}
		})
	}
}

// A rejected PATCH must leave the previous value alone.
func TestPreferencesRejectedPatchDoesNotClobber(t *testing.T) {
	s := store.NewFilePreferenceStore(t.TempDir())
	handlerOn(s, http.MethodPatch, `{"theme":"dark"}`, 0)
	handlerOn(s, http.MethodPatch, `{"theme":"light","wallpaper":"x"}`, 0)

	w := handlerOn(s, http.MethodGet, "", 0)
	var got map[string]string
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["theme"] != "dark" {
		t.Fatalf("a rejected PATCH changed stored state: got %v, want theme=dark", got)
	}
}

func TestPreferencesMethodNotAllowed(t *testing.T) {
	for _, m := range []string{http.MethodPut, http.MethodDelete, http.MethodPost} {
		if w := req(t, m, `{"theme":"dark"}`, 0); w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s got %d, want 405", m, w.Code)
		}
	}
}

// The file store must survive a restart — that is the entire reason it exists
// rather than an in-memory map.
func TestFilePreferenceStorePersistsAcrossReopen(t *testing.T) {
	dir := t.TempDir()
	if err := store.NewFilePreferenceStore(dir).Set(3, store.Preferences{"theme": "light"}); err != nil {
		t.Fatalf("set: %v", err)
	}
	got, err := store.NewFilePreferenceStore(dir).Get(3)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got["theme"] != "light" {
		t.Fatalf("preference did not survive reopen: %v", got)
	}
}

// A corrupt file must not stop the server booting; a lost cosmetic preference
// is strictly better than a crash loop.
func TestFilePreferenceStoreToleratesCorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "preferences.json"), []byte("{not json"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := store.NewFilePreferenceStore(dir).Get(0)
	if err != nil {
		t.Fatalf("a corrupt file should read as empty, got error: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("want empty, got %v", got)
	}
}

// DEFAULT_THEME is an operator convenience. A typo must not stop the server —
// it falls back to "auto" — and the field is always present because the login
// screen renders before any authenticated call.
func TestConfigDefaultTheme(t *testing.T) {
	for in, want := range map[string]string{
		"light": "light", "dark": "dark", "auto": "auto",
		"Light": "auto", "": "auto", "nonsense": "auto",
	} {
		h := NewConfigHandler("single", false, "", false)
		h.SetDefaultTheme(in)

		w := httptest.NewRecorder()
		h.HandleConfig(w, httptest.NewRequest(http.MethodGet, "/api/config", nil))

		var got map[string]interface{}
		json.Unmarshal(w.Body.Bytes(), &got)
		if got["defaultTheme"] != want {
			t.Fatalf("DEFAULT_THEME=%q: got %v, want %q", in, got["defaultTheme"], want)
		}
	}
}

// An operator who never sets DEFAULT_THEME still gets the field.
func TestConfigDefaultThemeAlwaysPresent(t *testing.T) {
	w := httptest.NewRecorder()
	NewConfigHandler("single", false, "", false).
		HandleConfig(w, httptest.NewRequest(http.MethodGet, "/api/config", nil))

	var got map[string]interface{}
	json.Unmarshal(w.Body.Bytes(), &got)
	if got["defaultTheme"] != "auto" {
		t.Fatalf("unset DEFAULT_THEME should serve auto, got %v", got["defaultTheme"])
	}
}
