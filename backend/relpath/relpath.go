// Package relpath holds the one lexical rule for namespace-relative paths.
// It has no imports from the rest of the backend so that both the permission
// middleware and the handlers can use it: the middleware must authorise the
// exact path a handler will act on, and two copies of this rule drift.
package relpath

import (
	"path/filepath"
	"strings"
)

// Clean validates a namespace-relative request path lexically and returns it
// cleaned with forward-slash separators. It returns ("", false) if the path is
// empty, absolute, escapes the namespace, or has a reserved segment (see
// IsReservedSegment). It does no filesystem access.
func Clean(reqPath string) (string, bool) {
	if reqPath == "" {
		return "", false
	}
	cleaned := filepath.ToSlash(filepath.Clean(reqPath))
	if strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "..") || cleaned == "." {
		return "", false
	}
	if HasReservedSegment(cleaned) {
		return "", false
	}
	return cleaned, true
}

// HasReservedSegment reports whether any segment of a slash-separated path is
// reserved (see IsReservedSegment).
func HasReservedSegment(p string) bool {
	for _, seg := range strings.Split(filepath.ToSlash(p), "/") {
		if IsReservedSegment(seg) {
			return true
		}
	}
	return false
}

// IsReservedSegment reports whether one path segment names something a request
// may never read or write: a git repository's internals (.git), whose config
// and hooks run commands the next time git touches the tree, or mdnest's own
// per-namespace data (.mdnest: comment threads, board settings), which only the
// server builds paths into. The match is case-insensitive and ignores what a
// case-insensitive (macOS) or Windows-style filesystem ignores when it maps a
// name to a file: trailing dots and spaces, and zero-width code points.
func IsReservedSegment(seg string) bool {
	switch normalizeSegment(seg) {
	case ".git", "git~1", ".mdnest":
		return true
	}
	return false
}

// IsGitSegment is IsReservedSegment narrowed to .git. Storage refuses it on
// every path, including server-built ones, since nothing in mdnest reaches a
// repository's internals through the storage layer.
func IsGitSegment(seg string) bool {
	n := normalizeSegment(seg)
	return n == ".git" || n == "git~1"
}

func normalizeSegment(seg string) string {
	seg = strings.Map(func(r rune) rune {
		switch {
		case r >= 0x200b && r <= 0x200f, r >= 0x202a && r <= 0x202e,
			r >= 0x2060 && r <= 0x206f, r == 0xfeff, r == 0x00ad:
			return -1 // ignorable: dropped when HFS+ and friends compare names
		}
		return r
	}, seg)
	return strings.ToLower(strings.TrimRight(seg, ". "))
}
