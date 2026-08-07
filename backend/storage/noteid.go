package storage

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// mdnest note-ID marker, embedded invisibly at the end of every note, e.g.
//
//	<!-- mdnest:8e44f72f-... -->
//
// It ties a note to its comment sidecar (.mdnest/comments/<uuid>.jsonl) so the
// link survives edits and renames. This mirrors the handler-side format; the
// storage layer keeps its own copy because it must not import handlers.
var noteMarkerRe = regexp.MustCompile(`(?m)^<!-- mdnest:([a-f0-9-]+) -->\s*$`)

// isNoteFile reports whether relPath is a user note (a .md file outside the
// .mdnest sidecar tree) eligible for marker reconciliation.
func isNoteFile(relPath string) bool {
	if !strings.HasSuffix(relPath, ".md") {
		return false
	}
	clean := strings.TrimPrefix(filepath.ToSlash(relPath), "./")
	return !strings.HasPrefix(clean, ".mdnest/")
}

// extractNoteMarker returns the marker UUID embedded in content, if any.
func extractNoteMarker(data []byte) (string, bool) {
	m := noteMarkerRe.FindSubmatch(data)
	if m == nil {
		return "", false
	}
	return string(m[1]), true
}

// setNoteMarker forces content to carry exactly uuid as its marker: an existing
// marker's UUID is swapped in place (preserving surrounding formatting); content
// without a marker gets one appended in the handler's canonical form.
func setNoteMarker(data []byte, uuid string) []byte {
	if loc := noteMarkerRe.FindSubmatchIndex(data); loc != nil {
		// Group 1 (the UUID) spans loc[2]:loc[3]; replace just that span so
		// the surrounding comment syntax and whitespace are untouched.
		out := make([]byte, 0, len(data)-(loc[3]-loc[2])+len(uuid))
		out = append(out, data[:loc[2]]...)
		out = append(out, uuid...)
		out = append(out, data[loc[3]:]...)
		return out
	}
	clean := bytes.TrimRight(data, "\n")
	return append(clean, []byte("\n\n<!-- mdnest:"+uuid+" -->\n")...)
}

// reconcileNoteMarker keeps a note's identity (its mdnest marker) stable across
// edits and, crucially, across a delete+recreate. A recreated note arrives with
// a freshly generated marker, which would orphan the old note's comment sidecar
// (.mdnest/comments/<oldUUID>.jsonl). When the path already carries a marker (on
// disk, or in git history for a path that was just recreated) that prior marker
// wins, so the note keeps its UUID and its comments reconnect automatically.
//
// It is a no-op for non-note paths and returns the input unchanged when there is
// nothing to recover (a genuinely new note, or no git repo).
func (g *GitStorage) reconcileNoteMarker(ctx context.Context, ns, relPath string, data []byte) []byte {
	if !isNoteFile(relPath) {
		return data
	}
	incoming, hasIncoming := extractNoteMarker(data)

	// Cheap path: the file already exists on disk. Its own marker is the
	// source of truth — a normal edit preserves it; an overwrite that changed
	// it is snapped back. No git needed.
	if cur, err := g.LocalStorage.ReadFile(ctx, ns, relPath); err == nil {
		if curUUID, ok := extractNoteMarker(cur); ok {
			if hasIncoming && incoming == curUUID {
				return data
			}
			return setNoteMarker(data, curUUID)
		}
	}

	// The file is absent or currently marker-less: treat this as a
	// (re)creation and recover the last marker the path carried in git.
	prev, ok := g.previousCommittedMarker(ctx, ns, relPath)
	if !ok {
		return data // brand-new note (or no git) — keep whatever it came with
	}
	if hasIncoming && incoming == prev {
		return data
	}
	return setNoteMarker(data, prev)
}

// previousCommittedMarker returns the most recent marker the path carried in the
// namespace's git history. It scans the last few commits that touched the path
// so a delete (whose tree lacks the blob) is skipped and the pre-delete version
// is found. ok is false when there is no git repo or no prior marker.
func (g *GitStorage) previousCommittedMarker(ctx context.Context, ns, relPath string) (string, bool) {
	dir := filepath.Join(g.root, ns)
	out, err := gitOutput(ctx, dir, "log", "-n", "30", "--pretty=format:%H", "--", relPath)
	if err != nil {
		return "", false
	}
	for _, sha := range strings.Fields(out) {
		blob, err := gitOutput(ctx, dir, "show", sha+":"+relPath)
		if err != nil {
			continue // path absent in this commit (e.g. the delete itself)
		}
		if uuid, ok := extractNoteMarker([]byte(blob)); ok {
			return uuid, true
		}
	}
	return "", false
}

// gitOutput runs a git command in dir and returns its stdout.
func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %v: %v: %s", args, err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}
