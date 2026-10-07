package handlers

import (
	"net/http"
	"sync"
)

// RestartHandler serves POST /api/admin/restart: restart the backend from
// Settings, so a stuck server does not need someone with SSH. main.go owns
// what a restart is (drain, flush storage, re-exec itself); this only answers
// the request and asks for it. Superadmin-only in multi mode; in single mode
// the one user already owns the server.
//
// A restart re-reads nothing Docker owns: mounts and the container's env are
// fixed when the container is created, so changing those still needs
// `docker compose up -d` on the host. The UI says so.
type RestartHandler struct {
	once    sync.Once
	trigger func()
}

// NewRestartHandler takes the function that starts the restart. It is
// called once, after the response has been sent.
func NewRestartHandler(trigger func()) *RestartHandler {
	return &RestartHandler{trigger: trigger}
}

func (h *RestartHandler) Handle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	w.Write([]byte(`{"status":"restarting"}` + "\n"))
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	// Repeated clicks while draining start one restart, not several.
	h.once.Do(func() { go h.trigger() })
}
