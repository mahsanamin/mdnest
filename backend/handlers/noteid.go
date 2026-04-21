package handlers

import (
	"crypto/rand"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// mdnest note ID marker — embedded as an HTML comment at the bottom of each note.
// Invisible to all markdown renderers. Used to link comments to notes by UUID
// so comments survive file moves/renames.
var noteIDRegex = regexp.MustCompile(`(?m)^<!-- mdnest:([a-f0-9-]+) -->\s*$`)

// ExtractNoteID finds the mdnest UUID marker in content.
// Returns the UUID and the content with the marker stripped.
// If no marker found, returns empty UUID and original content.
func ExtractNoteID(content string) (uuid string, body string) {
	match := noteIDRegex.FindStringSubmatchIndex(content)
	if match == nil {
		return "", content
	}
	uuid = content[match[2]:match[3]]
	// Remove the marker line (and trailing whitespace/newline)
	body = content[:match[0]] + strings.TrimRight(content[match[1]:], "\n")
	body = strings.TrimRight(body, "\n") + "\n"
	return uuid, body
}

// InjectNoteID appends the mdnest UUID marker to the end of content.
// If the content already has a marker, it's replaced.
func InjectNoteID(content string, uuid string) string {
	// Strip existing marker first
	_, clean := ExtractNoteID(content)
	clean = strings.TrimRight(clean, "\n")
	marker := fmt.Sprintf("\n\n<!-- mdnest:%s -->\n", uuid)
	return clean + marker
}

// GenerateNoteID creates a new random UUID v4.
func GenerateNoteID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// Set version 4 and variant bits
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}

// EnsureNoteID reads a file, injects a UUID if missing, writes back atomically.
// Returns the UUID (existing or new).
func EnsureNoteID(absPath string) (string, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", err
	}

	uuid, _ := ExtractNoteID(string(data))
	if uuid != "" {
		return uuid, nil // Already has one
	}

	// Generate new UUID
	uuid, err = GenerateNoteID()
	if err != nil {
		return "", fmt.Errorf("failed to generate note ID: %w", err)
	}

	// Write back with marker
	newContent := InjectNoteID(string(data), uuid)
	if err := os.WriteFile(absPath, []byte(newContent), 0644); err != nil {
		return "", fmt.Errorf("failed to write note ID: %w", err)
	}

	return uuid, nil
}

// ResolveNoteID gets the UUID for a note at the given path.
// If the note has no UUID yet, one is generated and injected.
func ResolveNoteID(notesDir, ns, path string) (string, error) {
	absPath := SafePath(fmt.Sprintf("%s/%s", notesDir, ns), path)
	if absPath == "" {
		return "", fmt.Errorf("invalid path")
	}
	return EnsureNoteID(absPath)
}
