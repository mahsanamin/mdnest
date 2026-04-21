package handlers

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
)

// Comment represents a single comment on a note.
// A comment with ParentID set is a reply in a thread; replies inherit their
// parent's anchor and resolved state at render time.
type Comment struct {
	ID         string  `json:"id"`
	ParentID   string  `json:"parentId,omitempty"`
	AuthorID   int     `json:"authorId"`
	Author     string  `json:"author"`
	RangeStart int     `json:"rangeStart"`
	RangeEnd   int     `json:"rangeEnd"`
	AnchorText string  `json:"anchorText"`
	Body       string  `json:"body"`
	CreatedAt  string  `json:"createdAt"`
	Resolved   bool    `json:"resolved"`
	DeletedAt  *string `json:"deletedAt,omitempty"`
}

// CommentsHandler handles CRUD for inline comments.
type CommentsHandler struct {
	notesDir string
}

// NewCommentsHandler creates a new comments handler.
func NewCommentsHandler(notesDir string) *CommentsHandler {
	return &CommentsHandler{notesDir: notesDir}
}

// Handle routes /api/comments
func (h *CommentsHandler) Handle(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		h.listComments(w, r)
	case http.MethodPost:
		h.createComment(w, r)
	case http.MethodPatch:
		h.updateComment(w, r)
	case http.MethodDelete:
		h.deleteComment(w, r)
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// commentsDir returns the path to .mdnest/comments/ for a namespace.
func (h *CommentsHandler) commentsDir(ns string) string {
	return filepath.Join(h.notesDir, ns, ".mdnest", "comments")
}

// commentsFile returns the JSONL file for a note's UUID.
func (h *CommentsHandler) commentsFile(ns, noteID string) string {
	return filepath.Join(h.commentsDir(ns), noteID+".jsonl")
}

// resolveNoteID gets the UUID for the given ns/path, generating one if needed.
func (h *CommentsHandler) resolveNoteID(ns, notePath string) (string, error) {
	nsDir := filepath.Join(h.notesDir, ns)
	absPath := SafePath(nsDir, notePath)
	if absPath == "" {
		return "", fmt.Errorf("invalid path")
	}
	return EnsureNoteID(absPath)
}

// listComments returns all non-deleted comments for a note.
func (h *CommentsHandler) listComments(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	notePath := r.URL.Query().Get("path")
	if ns == "" || notePath == "" {
		http.Error(w, `{"error":"ns and path are required"}`, http.StatusBadRequest)
		return
	}

	noteID, err := h.resolveNoteID(ns, notePath)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve note"}`, http.StatusInternalServerError)
		return
	}

	comments, err := h.readComments(ns, noteID)
	if err != nil {
		// No comments file = empty list (not an error)
		comments = []Comment{}
	}

	// Filter out deleted comments
	active := make([]Comment, 0)
	for _, c := range comments {
		if c.DeletedAt == nil {
			active = append(active, c)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(active)
}

// createComment appends a new comment to the JSONL file.
func (h *CommentsHandler) createComment(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	notePath := r.URL.Query().Get("path")
	if ns == "" || notePath == "" {
		http.Error(w, `{"error":"ns and path are required"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		ParentID   string `json:"parentId"`
		RangeStart int    `json:"rangeStart"`
		RangeEnd   int    `json:"rangeEnd"`
		AnchorText string `json:"anchorText"`
		Body       string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.Body == "" {
		http.Error(w, `{"error":"comment body is required"}`, http.StatusBadRequest)
		return
	}

	uc := middleware.UserFromContext(r.Context())
	if uc == nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	noteID, err := h.resolveNoteID(ns, notePath)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve note"}`, http.StatusInternalServerError)
		return
	}

	commentID, _ := GenerateNoteID() // Reuse UUID generator for comment IDs
	comment := Comment{
		ID:         "c_" + commentID[:8],
		ParentID:   req.ParentID,
		AuthorID:   uc.ID,
		Author:     uc.Username,
		RangeStart: req.RangeStart,
		RangeEnd:   req.RangeEnd,
		AnchorText: req.AnchorText,
		Body:       req.Body,
		CreatedAt:  time.Now().UTC().Format(time.RFC3339),
		Resolved:   false,
	}

	if err := h.appendComment(ns, noteID, comment); err != nil {
		log.Printf("failed to append comment: %v", err)
		http.Error(w, `{"error":"failed to save comment"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(comment)
}

// updateComment marks a comment as resolved or updates its body.
func (h *CommentsHandler) updateComment(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	notePath := r.URL.Query().Get("path")
	commentID := r.URL.Query().Get("id")
	if ns == "" || notePath == "" || commentID == "" {
		http.Error(w, `{"error":"ns, path, and id are required"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		Resolved *bool   `json:"resolved,omitempty"`
		Body     *string `json:"body,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	noteID, err := h.resolveNoteID(ns, notePath)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve note"}`, http.StatusInternalServerError)
		return
	}

	comments, err := h.readComments(ns, noteID)
	if err != nil {
		http.Error(w, `{"error":"comment not found"}`, http.StatusNotFound)
		return
	}

	found := false
	for i, c := range comments {
		if c.ID == commentID {
			if req.Resolved != nil {
				comments[i].Resolved = *req.Resolved
			}
			if req.Body != nil {
				comments[i].Body = *req.Body
			}
			found = true
			break
		}
	}

	if !found {
		http.Error(w, `{"error":"comment not found"}`, http.StatusNotFound)
		return
	}

	if err := h.writeComments(ns, noteID, comments); err != nil {
		http.Error(w, `{"error":"failed to update comment"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// deleteComment soft-deletes a comment.
func (h *CommentsHandler) deleteComment(w http.ResponseWriter, r *http.Request) {
	ns := r.URL.Query().Get("ns")
	notePath := r.URL.Query().Get("path")
	commentID := r.URL.Query().Get("id")
	if ns == "" || notePath == "" || commentID == "" {
		http.Error(w, `{"error":"ns, path, and id are required"}`, http.StatusBadRequest)
		return
	}

	noteID, err := h.resolveNoteID(ns, notePath)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve note"}`, http.StatusInternalServerError)
		return
	}

	comments, err := h.readComments(ns, noteID)
	if err != nil {
		http.Error(w, `{"error":"comment not found"}`, http.StatusNotFound)
		return
	}

	now := time.Now().UTC().Format(time.RFC3339)
	found := false
	for i, c := range comments {
		if c.ID == commentID {
			comments[i].DeletedAt = &now
			found = true
			break
		}
	}

	if !found {
		http.Error(w, `{"error":"comment not found"}`, http.StatusNotFound)
		return
	}

	if err := h.writeComments(ns, noteID, comments); err != nil {
		http.Error(w, `{"error":"failed to delete comment"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// readComments reads all comments from the JSONL file.
func (h *CommentsHandler) readComments(ns, noteID string) ([]Comment, error) {
	file, err := os.Open(h.commentsFile(ns, noteID))
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var comments []Comment
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var c Comment
		if err := json.Unmarshal([]byte(line), &c); err != nil {
			continue // Skip malformed lines
		}
		comments = append(comments, c)
	}
	return comments, scanner.Err()
}

// appendComment appends a single comment to the JSONL file (O_APPEND for concurrency safety).
func (h *CommentsHandler) appendComment(ns, noteID string, comment Comment) error {
	dir := h.commentsDir(ns)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.Marshal(comment)
	if err != nil {
		return err
	}

	f, err := os.OpenFile(h.commentsFile(ns, noteID), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()

	_, err = f.Write(append(data, '\n'))
	return err
}

// writeComments rewrites the entire JSONL file (used for updates/deletes).
func (h *CommentsHandler) writeComments(ns, noteID string, comments []Comment) error {
	dir := h.commentsDir(ns)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	var lines []byte
	for _, c := range comments {
		data, err := json.Marshal(c)
		if err != nil {
			continue
		}
		lines = append(lines, data...)
		lines = append(lines, '\n')
	}

	return os.WriteFile(h.commentsFile(ns, noteID), lines, 0644)
}
