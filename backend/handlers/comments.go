package handlers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/mdnest/mdnest/backend/middleware"
	"github.com/mdnest/mdnest/backend/storage"
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
	store storage.Storage
}

// NewCommentsHandler creates a new comments handler.
func NewCommentsHandler(store storage.Storage) *CommentsHandler {
	return &CommentsHandler{store: store}
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

// commentsFile returns the JSONL file (relative path within the namespace)
// for a note's UUID.
func (h *CommentsHandler) commentsFile(noteID string) string {
	return path.Join(".mdnest", "comments", noteID+".jsonl")
}

// resolveNoteID gets the UUID for the given ns/path, generating one if needed.
func (h *CommentsHandler) resolveNoteID(ctx context.Context, ns, notePath string) (string, error) {
	relPath, ok := SafeRelPath(notePath)
	if !ok {
		return "", fmt.Errorf("invalid path")
	}
	return EnsureNoteIDStore(ctx, h.store, ns, relPath)
}

// listComments returns all non-deleted comments for a note.
func (h *CommentsHandler) listComments(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := r.URL.Query().Get("ns")
	notePath := r.URL.Query().Get("path")
	if ns == "" || notePath == "" {
		http.Error(w, `{"error":"ns and path are required"}`, http.StatusBadRequest)
		return
	}

	noteID, err := h.resolveNoteID(ctx, ns, notePath)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve note"}`, http.StatusInternalServerError)
		return
	}

	comments, err := h.readComments(ctx, ns, noteID)
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
	ctx := r.Context()
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

	noteID, err := h.resolveNoteID(ctx, ns, notePath)
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

	if err := h.appendComment(ctx, ns, noteID, comment); err != nil {
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
	ctx := r.Context()
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

	noteID, err := h.resolveNoteID(ctx, ns, notePath)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve note"}`, http.StatusInternalServerError)
		return
	}

	comments, err := h.readComments(ctx, ns, noteID)
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

	if err := h.writeComments(ctx, ns, noteID, comments); err != nil {
		http.Error(w, `{"error":"failed to update comment"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// deleteComment soft-deletes a comment.
func (h *CommentsHandler) deleteComment(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ns := r.URL.Query().Get("ns")
	notePath := r.URL.Query().Get("path")
	commentID := r.URL.Query().Get("id")
	if ns == "" || notePath == "" || commentID == "" {
		http.Error(w, `{"error":"ns, path, and id are required"}`, http.StatusBadRequest)
		return
	}

	noteID, err := h.resolveNoteID(ctx, ns, notePath)
	if err != nil {
		http.Error(w, `{"error":"failed to resolve note"}`, http.StatusInternalServerError)
		return
	}

	comments, err := h.readComments(ctx, ns, noteID)
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

	if err := h.writeComments(ctx, ns, noteID, comments); err != nil {
		http.Error(w, `{"error":"failed to delete comment"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// readComments reads all comments from the JSONL file.
func (h *CommentsHandler) readComments(ctx context.Context, ns, noteID string) ([]Comment, error) {
	data, err := h.store.ReadFile(ctx, ns, h.commentsFile(noteID))
	if err != nil {
		return nil, err
	}

	var comments []Comment
	scanner := bufio.NewScanner(bytes.NewReader(data))
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

// appendComment appends a single comment to the JSONL file.
func (h *CommentsHandler) appendComment(ctx context.Context, ns, noteID string, comment Comment) error {
	data, err := json.Marshal(comment)
	if err != nil {
		return err
	}
	return h.store.Append(ctx, ns, h.commentsFile(noteID), append(data, '\n'))
}

// writeComments rewrites the entire JSONL file (used for updates/deletes).
func (h *CommentsHandler) writeComments(ctx context.Context, ns, noteID string, comments []Comment) error {
	var lines []byte
	for _, c := range comments {
		data, err := json.Marshal(c)
		if err != nil {
			continue
		}
		lines = append(lines, data...)
		lines = append(lines, '\n')
	}

	return h.store.WriteFile(ctx, ns, h.commentsFile(noteID), lines)
}
