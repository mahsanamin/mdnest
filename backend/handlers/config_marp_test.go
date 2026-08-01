package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Marp is off by default: /api/config must not advertise it unless the operator
// turned it on, so the frontend never loads the Marp engine chunk otherwise.
func TestConfigMarpFlag(t *testing.T) {
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
			h.SetMarp(tc.on)
			w := httptest.NewRecorder()
			h.HandleConfig(w, httptest.NewRequest(http.MethodGet, "/api/config", nil))
			var got map[string]interface{}
			if err := json.NewDecoder(w.Body).Decode(&got); err != nil {
				t.Fatal(err)
			}
			_, present := got["marp"]
			if present != tc.want {
				t.Errorf("marp advertised=%v, want %v (body=%v)", present, tc.want, got)
			}
		})
	}
}
