package handlers

import (
	"regexp"
	"strings"
	"time"
	"unicode"
)

// The PURE half of file-based chat: recognise a chat note, parse its
// messages, render a new one, and turn an ordinary note into a chat. No
// storage, no HTTP — chat.go does the request handling.
//
// A chat is an ordinary markdown note. Two things make it one:
//
//	---
//	mdnest-chat: true
//	title: Release coordination
//	---
//
//	Anything here is the channel's description.
//
//	#### alice · 2026-10-02T14:03:05Z
//
//	First message.
//
//	#### claude-api (via ahsan) · 2026-10-02T14:04:10Z
//
//	A reply, posted by an agent on ahsan's token.
//
// The front-matter tag is the ONLY marker — no database, no sidecar file, no
// index. Messages are appended, never rewritten, so the file reads fine in
// any markdown viewer, diffs cleanly under git-sync, and an agent that only
// has `mdnest append` can still take part by writing the same header shape.

// chatMarkerKey is the front-matter key that marks a note as a chat.
const chatMarkerKey = "mdnest-chat"

// chatHeaderRe matches a message header line. The timestamp is the anchor:
// it is what makes an ordinary "#### heading" in a description not a message.
var chatHeaderRe = regexp.MustCompile(`^#### (.+?) · (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s*$`)

// chatViaRe splits "label (via account)" — the shape used when the posting
// label differs from the authenticated account (an agent on a user's token).
var chatViaRe = regexp.MustCompile(`^(.*\S) \(via ([^()]+)\)$`)

// ChatMessage is one parsed message. N is its 1-based position in the file;
// because chats are append-only it is a stable cursor ("everything after 12").
type ChatMessage struct {
	N      int    `json:"n"`
	Author string `json:"author"`
	Via    string `json:"via,omitempty"`
	Time   string `json:"time"`
	Text   string `json:"text"`
}

// ChatDoc is a parsed chat note.
type ChatDoc struct {
	IsChat      bool
	Title       string
	Description string
	Messages    []ChatMessage
	// Agents is each agent's saved role, by name (chat_traits.go).
	Agents map[string]string
}

// splitFrontMatter returns the front-matter body (without the --- fences) and
// the rest of the document. ok is false when the note has no front matter.
func splitFrontMatter(content string) (fm, rest string, ok bool) {
	c := strings.TrimPrefix(content, "\ufeff")
	if !strings.HasPrefix(c, "---\n") && !strings.HasPrefix(c, "---\r\n") {
		return "", content, false
	}
	nl := strings.Index(c, "\n") + 1
	body := c[nl:]
	// Closing fence: a line that is exactly "---".
	off := 0
	for {
		end := strings.Index(body[off:], "\n")
		var line string
		if end == -1 {
			line = body[off:]
		} else {
			line = body[off : off+end]
		}
		if strings.TrimRight(line, "\r") == "---" {
			fm = body[:off]
			if end == -1 {
				rest = ""
			} else {
				rest = body[off+end+1:]
			}
			return fm, rest, true
		}
		if end == -1 {
			return "", content, false
		}
		off += end + 1
	}
}

// frontMatterValue reads a top-level `key: value` from front matter. It is a
// deliberately tiny reader — chat only needs two flat string keys, and a full
// YAML parser would be a new dependency for no gain.
func frontMatterValue(fm, key string) (string, bool) {
	for _, line := range strings.Split(fm, "\n") {
		line = strings.TrimRight(line, "\r")
		k, v, found := strings.Cut(line, ":")
		if !found || strings.TrimSpace(k) != key || strings.HasPrefix(line, " ") {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		return v, true
	}
	return "", false
}

// IsChatNote is the cheap check used when scanning a namespace for chats.
func IsChatNote(content string) bool {
	fm, _, ok := splitFrontMatter(content)
	if !ok {
		return false
	}
	v, _ := frontMatterValue(fm, chatMarkerKey)
	return strings.EqualFold(v, "true")
}

// ParseChat parses a note. Content that is not a chat still parses (IsChat is
// false) so callers can tell "not a chat" apart from "empty chat".
func ParseChat(content string) ChatDoc {
	_, content = ExtractNoteID(content)
	fm, rest, ok := splitFrontMatter(content)
	doc := ChatDoc{}
	if ok {
		v, _ := frontMatterValue(fm, chatMarkerKey)
		doc.IsChat = strings.EqualFold(v, "true")
		doc.Title, _ = frontMatterValue(fm, "title")
		doc.Agents = ChatTraits(fm)
	} else {
		rest = content
	}

	lines := strings.Split(strings.ReplaceAll(rest, "\r\n", "\n"), "\n")
	var desc []string
	var cur *ChatMessage
	var body []string
	flush := func() {
		if cur != nil {
			cur.Text = unescapeChatBody(strings.Trim(strings.Join(body, "\n"), "\n"))
			doc.Messages = append(doc.Messages, *cur)
		}
		body = nil
	}
	for _, line := range lines {
		if m := chatHeaderRe.FindStringSubmatch(line); m != nil {
			flush()
			author, via := m[1], ""
			if v := chatViaRe.FindStringSubmatch(author); v != nil {
				author, via = v[1], v[2]
			}
			cur = &ChatMessage{N: len(doc.Messages) + 1, Author: author, Via: via, Time: m[2]}
			continue
		}
		if cur == nil {
			desc = append(desc, line)
		} else {
			body = append(body, line)
		}
	}
	flush()
	doc.Description = strings.TrimSpace(strings.Join(desc, "\n"))
	return doc
}

// chatMentionRe finds @name tokens: an @ at the start or after a non-word
// character (so an email address is not a mention), then a name made of the
// characters a posting label usually has.
var chatMentionRe = regexp.MustCompile(`(?:^|[^\w@])@([\w][\w.\-]*)`)

// ChatMentions reports whether text addresses name: @name (case-insensitive)
// or one of the broadcast forms @all / @everyone.
func ChatMentions(text, name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return false
	}
	for _, m := range chatMentionRe.FindAllStringSubmatch(text, -1) {
		got := strings.ToLower(strings.TrimRight(m[1], ".-"))
		if got == name || got == "all" || got == "everyone" {
			return true
		}
	}
	return false
}

// escapeChatBody stops a message body from forging a message boundary: any
// line that would parse as a header gets a leading backslash, which markdown
// renders as a literal "#" and the parser no longer matches.
func escapeChatBody(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		// Escape already-escaped lines too, so unescape (which strips exactly
		// one backslash) round-trips a body that literally contains one.
		if chatHeaderRe.MatchString(strings.TrimLeft(l, `\`)) {
			lines[i] = `\` + l
		}
	}
	return strings.Join(lines, "\n")
}

func unescapeChatBody(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		if strings.HasPrefix(l, `\`) && chatHeaderRe.MatchString(strings.TrimLeft(l, "\\")) {
			lines[i] = l[1:]
		}
	}
	return strings.Join(lines, "\n")
}

// sanitizeChatLabel keeps an author label on one line and out of the header
// syntax: no newlines, no " · " separator, no parentheses (which "(via x)"
// owns), and a sane length.
func sanitizeChatLabel(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r == '(' || r == ')' || r == '·':
			return ' '
		// Control characters (incl. ESC and newlines) and the bidi
		// overrides/isolates that make a label display as something else.
		case unicode.IsControl(r), r >= 0x202A && r <= 0x202E, r >= 0x2066 && r <= 0x2069, r == 0x200E, r == 0x200F:
			return ' '
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	if len([]rune(s)) > 60 {
		s = string([]rune(s)[:60])
	}
	return strings.TrimSpace(s)
}

// RenderChatMessage renders one message block, with a leading blank line so
// it can be appended to any document.
func RenderChatMessage(author, via string, at time.Time, text string) string {
	label := author
	if via != "" && via != author {
		label = author + " (via " + via + ")"
	}
	text = strings.Trim(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	return "\n#### " + label + " · " + at.UTC().Format("2006-01-02T15:04:05Z") + "\n\n" + escapeChatBody(text) + "\n"
}

// AppendChatMessage appends a rendered message to a chat note, keeping the
// note-ID marker (if any) at the very end where the comments feature expects it.
func AppendChatMessage(content, block string) string {
	// A message never carries an identity: a marker line in it would become
	// the id of a chat that has none yet (and so its comment thread).
	if id, clean := StripAllNoteIDs(block); id != "" {
		block = clean
	}
	id, body := ExtractNoteID(content)
	out := strings.TrimRight(body, "\n") + "\n" + block
	if id != "" {
		out = InjectNoteID(out, id)
	}
	return out
}

// ConvertToChat adds the chat marker (and a title, if the note has none) to a
// note. Existing content is kept and becomes the channel description; the
// file is never moved, so any path an agent was handed keeps working.
// Idempotent: converting a chat changes nothing.
func ConvertToChat(content, title string) string {
	if IsChatNote(content) {
		return content
	}
	title = sanitizeChatLabel(title)
	fm, rest, ok := splitFrontMatter(content)
	var b strings.Builder
	b.WriteString("---\n")
	if ok {
		// Keep every existing key, drop a stale "mdnest-chat: false".
		for _, line := range strings.Split(strings.TrimRight(fm, "\n"), "\n") {
			k, _, _ := strings.Cut(line, ":")
			if strings.TrimSpace(k) == chatMarkerKey {
				continue
			}
			b.WriteString(line + "\n")
		}
	}
	b.WriteString(chatMarkerKey + ": true\n")
	if _, has := frontMatterValue(fm, "title"); !has && title != "" {
		b.WriteString("title: " + title + "\n")
	}
	b.WriteString("---\n")
	if !ok {
		rest = content
	}
	if r := strings.TrimLeft(rest, "\n"); r != "" {
		b.WriteString("\n" + r)
		if !strings.HasSuffix(r, "\n") {
			b.WriteString("\n")
		}
	}
	return b.String()
}
