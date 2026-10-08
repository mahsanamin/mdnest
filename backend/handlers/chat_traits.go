package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/mdnest/mdnest/backend/storage"
)

// Each agent's role in a chat, kept in the note's front matter so it lasts as
// long as the chat does and reads fine in any markdown viewer:
//
//	---
//	mdnest-chat: true
//	title: Release coordination
//	agents:
//	  lead-coder: "You lead the coding. Split the work and review what helpers deliver."
//	  qa-1: "You test one area your QA lead gives you."
//	---
//
// Agents forget the job they were given once their context fills up and gets
// summarised. So every time `chat wait` (or MCP wait_chat) hands an agent new
// messages, the server adds one line repeating that agent's saved role. The
// wait output is the one thing an agent reads on every turn of its loop,
// whatever it has forgotten, and it needs no CLI update.
//
// The role is set from the Connect an agent panel (saved when the prompt is
// copied), with POST /api/chat/agents, or by the agent itself posting
// "/role ..." (the same slash rule as /status and /context).

const chatAgentsKey = "agents"

// maxChatTrait keeps a role to the line or two it is meant to be: it is
// repeated on every wait, so a long one would crowd out the messages.
const maxChatTrait = 300

// chatTraitNameRe is the shape of a name a role can be saved for: what the
// Connect an agent panel allows, and a safe YAML key.
var chatTraitNameRe = regexp.MustCompile(`^[\w][\w.-]{0,59}$`)

const errTraitName = "a role can only be saved for a name made of letters, digits, '.', '_' and '-'"

// cleanChatTrait puts a role on one line, without control or direction
// characters, and cuts it to maxChatTrait characters.
func cleanChatTrait(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case unicode.IsControl(r), r >= 0x202A && r <= 0x202E, r >= 0x2066 && r <= 0x2069, r == 0x200E, r == 0x200F:
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if r := []rune(s); len(r) > maxChatTrait {
		s = strings.TrimSpace(string(r[:maxChatTrait-1])) + "…"
	}
	return s
}

// chatTraitEntry is one "  name: role" line of the agents block.
type chatTraitEntry struct{ name, trait string }

// isAgentsKeyLine reports whether a front-matter line opens the agents block.
func isAgentsKeyLine(line string) bool {
	k, v, found := strings.Cut(strings.TrimRight(line, "\r"), ":")
	return found && k == chatAgentsKey && strings.TrimSpace(v) == ""
}

func isIndented(line string) bool {
	return strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")
}

func parseTraitLine(line string) (chatTraitEntry, bool) {
	k, v, found := strings.Cut(strings.TrimSpace(strings.TrimRight(line, "\r")), ":")
	k, v = strings.TrimSpace(k), strings.TrimSpace(v)
	if !found || !chatTraitNameRe.MatchString(k) {
		return chatTraitEntry{}, false
	}
	if strings.HasPrefix(v, `"`) {
		if u, err := strconv.Unquote(v); err == nil {
			v = u
		}
	} else if len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'' {
		v = strings.ReplaceAll(v[1:len(v)-1], "''", "'")
	}
	if v = cleanChatTrait(v); v == "" {
		return chatTraitEntry{}, false
	}
	return chatTraitEntry{k, v}, true
}

// splitAgentsBlock separates the agents block from the rest of the front
// matter. before/after are the other lines, in order, around where it was.
func splitAgentsBlock(fm string) (before, after []string, entries []chatTraitEntry, found bool) {
	lines := strings.Split(strings.TrimRight(fm, "\n"), "\n")
	if fm == "" {
		lines = nil
	}
	for i := 0; i < len(lines); i++ {
		if found || !isAgentsKeyLine(lines[i]) {
			if found {
				after = append(after, lines[i])
			} else {
				before = append(before, lines[i])
			}
			continue
		}
		found = true
		for i+1 < len(lines) && isIndented(lines[i+1]) {
			i++
			if e, ok := parseTraitLine(lines[i]); ok {
				entries = append(entries, e)
			}
		}
	}
	return before, after, entries, found
}

// ChatTraits reads the saved roles from a chat note's front matter.
func ChatTraits(fm string) map[string]string {
	_, _, entries, _ := splitAgentsBlock(fm)
	out := map[string]string{}
	for _, e := range entries {
		out[e.name] = e.trait
	}
	return out
}

// chatTraitFor finds name's role, matching the name the way mentions do
// (case-insensitively), so @Codxu and codxu are the same agent.
func chatTraitFor(traits map[string]string, name string) string {
	for k, v := range traits {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

// SetChatTrait saves (or, with an empty trait, removes) name's role in a chat
// note and returns the new content. Every other front-matter line, the
// messages and the note-ID marker are left exactly as they were.
func SetChatTrait(content, name, trait string) (string, error) {
	if !chatTraitNameRe.MatchString(name) {
		return "", errors.New(errTraitName)
	}
	fm, rest, ok := splitFrontMatter(content)
	if !ok {
		return "", errors.New("this note is not a chat")
	}
	trait = cleanChatTrait(trait)
	before, after, entries, _ := splitAgentsBlock(fm)
	kept := entries[:0]
	replaced := false
	for _, e := range entries {
		if strings.EqualFold(e.name, name) {
			if trait != "" && !replaced {
				kept = append(kept, chatTraitEntry{name, trait})
				replaced = true
			}
			continue
		}
		kept = append(kept, e)
	}
	if trait != "" && !replaced {
		kept = append(kept, chatTraitEntry{name, trait})
	}
	var b strings.Builder
	b.WriteString("---\n")
	for _, l := range before {
		b.WriteString(l + "\n")
	}
	if len(kept) > 0 {
		b.WriteString(chatAgentsKey + ":\n")
		for _, e := range kept {
			b.WriteString("  " + e.name + ": " + strconv.Quote(e.trait) + "\n")
		}
	}
	for _, l := range after {
		b.WriteString(l + "\n")
	}
	b.WriteString("---\n")
	return b.String() + rest, nil
}

// chatTraitReminder is the line added after the new messages a waiting agent
// gets. It comes last so it is the freshest thing the agent reads.
func chatTraitReminder(name, trait string) string {
	return terminalSafe(fmt.Sprintf("(reminder for %s) Your role in this chat: %s\nKeep to this role unless a human gives you a new one.\n\n", name, trait))
}

// slashRole recognises a post that is a /role command and returns its text
// ("" removes the role). "/roles" or "/role-x" are ordinary messages.
func slashRole(text string) (string, bool) {
	if !strings.HasPrefix(text, "/role") {
		return "", false
	}
	rest := text[len("/role"):]
	if rest != "" && rest[0] != ' ' && rest[0] != '\t' && rest[0] != '\n' {
		return "", false
	}
	return strings.TrimSpace(rest), true
}

// HandleAgents: POST /api/chat/agents?ns=&path=&name= with the role as the
// body; an empty body removes it. Guarded like posting: anyone who may write
// the chat may set a role in it, as they could by editing the note.
func (h *ChatHandler) HandleAgents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		chatJSONError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	ns, relPath, ok := h.chatTarget(w, r)
	if !ok {
		return
	}
	if _, _, ok := h.authorFor(r, ""); !ok {
		chatJSONError(w, http.StatusForbidden, "cannot attribute this change to a user")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 8192))
	if err != nil {
		chatJSONError(w, http.StatusBadRequest, "failed to read body")
		return
	}
	h.applyTrait(w, r, ns, relPath, strings.TrimSpace(r.URL.Query().Get("name")), string(body))
}

func (h *ChatHandler) applyTrait(w http.ResponseWriter, r *http.Request, ns, relPath, name, trait string) {
	if !chatTraitNameRe.MatchString(name) {
		chatJSONError(w, http.StatusBadRequest, errTraitName)
		return
	}
	ctx := r.Context()
	unlock := lockNote(ns, relPath)
	data, err := h.store.ReadFile(ctx, ns, relPath)
	if errors.Is(err, storage.ErrNotExist) {
		unlock()
		chatJSONError(w, http.StatusNotFound, "chat not found — create it first")
		return
	} else if err != nil {
		unlock()
		chatJSONError(w, http.StatusInternalServerError, "failed to read chat")
		return
	}
	content := string(data)
	if !IsChatNote(content) {
		unlock()
		chatJSONError(w, http.StatusBadRequest, "this note is not a chat — convert it first")
		return
	}
	updated, err := SetChatTrait(content, name, trait)
	if err != nil {
		unlock()
		chatJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(updated) > maxNoteSize {
		unlock()
		chatJSONError(w, http.StatusRequestEntityTooLarge, "chat is full (10MB) — start a new one")
		return
	}
	if updated != content {
		if err := h.store.WriteFile(ctx, ns, relPath, []byte(updated)); err != nil {
			unlock()
			chatJSONError(w, http.StatusInternalServerError, "failed to write chat")
			return
		}
	}
	unlock()
	if updated != content {
		h.notify(r, ns, relPath, updated)
	}
	saved := cleanChatTrait(trait)
	status := "saved"
	if saved == "" {
		status = "removed"
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": status, "name": name, "role": saved})
}

// agentsOrEmpty keeps the JSON field an object, never null.
func agentsOrEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}
