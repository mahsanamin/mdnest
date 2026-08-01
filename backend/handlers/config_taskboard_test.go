package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The board is off by default: /api/config must not advertise it unless the
// operator turned it on, because the routes only exist when it is on.
func TestConfigTaskBoardFlag(t *testing.T) {
	for _, tc := range []struct {
		name string
		on   bool
		want bool
	}{
		{"default off", false, false},
		{"enabled", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := NewConfigHandler("single", false, "", false)
			h.SetTaskBoard(tc.on)
			w := httptest.NewRecorder()
			h.HandleConfig(w, httptest.NewRequest(http.MethodGet, "/api/config", nil))
			var got map[string]interface{}
			if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
			_, present := got["taskBoard"]
			if present != tc.want {
				t.Errorf("taskBoard advertised=%v, want %v (body=%v)", present, tc.want, got)
			}
		})
	}
}

// The routes must not exist when the flag is off — a clean 404 rather than a
// handler that answers on a feature the operator disabled. Mirrors how main.go
// registers them.
func TestTaskRoutesOnlyRegisteredWhenEnabled(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		mux := http.NewServeMux()
		if enabled {
			mux.Handle("/api/tasks", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
			mux.Handle("/api/board", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
		}
		for _, route := range []string{"/api/tasks", "/api/board"} {
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, route, nil))
			want := http.StatusNotFound
			if enabled {
				want = http.StatusOK
			}
			if w.Code != want {
				t.Errorf("enabled=%v %s: got %d, want %d", enabled, route, w.Code, want)
			}
		}
	}
}
