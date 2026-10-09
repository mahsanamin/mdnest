package handlers

import (
	"encoding/json"
	"testing"
)

// The pure parts of agent approvals. The route behaviour (token refusal,
// owner isolation, expiry, close) is in routes_approvals_test.go, through the
// real auth middleware.

func TestApprovalsEnabled(t *testing.T) {
	cases := []struct {
		setting, role string
		want          bool
	}{
		{"", "single", false}, // off by default
		{"false", "single", false},
		{"true", "single", true},
		{"true", "writer", true},
		{"TRUE", "", true},
		{"true", "app", false}, // per-process state cannot work across replicas
		{"yes", "app", false},
	}
	for _, c := range cases {
		if got := ApprovalsEnabled(c.setting, c.role); got != c.want {
			t.Errorf("ApprovalsEnabled(%q, %q) = %v, want %v", c.setting, c.role, got, c.want)
		}
	}
}

func TestVersionAtLeast(t *testing.T) {
	cases := map[string]bool{
		"4.8.5": true, "4.8.5-dev": true, "v4.8.5": true, "4.8.6": true, "4.9.0": true, "5.0.0": true,
		"4.8.4": false, "4.7.9": false, "3.99.99": false, "": false, "4.8": false, "x.y.z": false,
	}
	for v, want := range cases {
		if got := versionAtLeast(v, ApprovalMinCLI); got != want {
			t.Errorf("versionAtLeast(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestCommandOf(t *testing.T) {
	cases := []struct{ in, cmd, desc string }{
		{`{"command":"ls -la","description":"List"}`, "ls -la", "List"},
		{`{"command":["git","status"]}`, "git status", ""},
		{`{"command":["bash","-lc","make; rm -rf x"]}`, "bash -lc 'make; rm -rf x'", ""},
		{`{"command":["echo","it's"]}`, `echo 'it'\''s'`, ""},
		{`{"file_path":"/a.md"}`, "{\n  \"file_path\": \"/a.md\"\n}", ""},
	}
	for _, c := range cases {
		cmd, desc := commandOf(json.RawMessage(c.in))
		if cmd != c.cmd || desc != c.desc {
			t.Errorf("commandOf(%s) = %q, %q; want %q, %q", c.in, cmd, desc, c.cmd, c.desc)
		}
	}
}

func TestHookOutput(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		if got := string(hookOutput(agent, ApprovalAllowed, "")); got != `{"hookSpecificOutput":{"decision":{"behavior":"allow"},"hookEventName":"PermissionRequest"}}`+"\n" {
			t.Errorf("%s allow: %s", agent, got)
		}
		if got := string(hookOutput(agent, ApprovalDenied, "")); got != `{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"Denied from mdnest."},"hookEventName":"PermissionRequest"}}`+"\n" {
			t.Errorf("%s deny: %s", agent, got)
		}
	}
}

func TestSplitChatRef(t *testing.T) {
	ok := map[string][2]string{"notes/Chats/a.md": {"notes", "Chats/a.md"}, "/n/x.md": {"n", "x.md"}}
	for in, want := range ok {
		ns, p, good := splitChatRef(in)
		if !good || ns != want[0] || p != want[1] {
			t.Errorf("splitChatRef(%q) = %q %q %v", in, ns, p, good)
		}
	}
	for _, bad := range []string{"", "x.md", "n/a/../b.md", "n/a.txt", ".marp-themes/a.md", "n//a.md"} {
		if _, _, good := splitChatRef(bad); good {
			t.Errorf("splitChatRef(%q) accepted", bad)
		}
	}
}

func TestVisibleText(t *testing.T) {
	cases := map[string]string{
		"ls -la\n\tpwd":        "ls -la\n\tpwd",
		"rm -rf \u202Etxt.exe": `rm -rf \u{202E}txt.exe`,
		"echo safe\rrm -rf /":  `echo safe\u{000D}rm -rf /`,
		"git\u200Bpush":        `git\u{200B}push`,
		"caf\u00e9 \u65e5\u672c \u00e9t\u00e9 \u2192 \u20ac5": "caf\u00e9 \u65e5\u672c \u00e9t\u00e9 \u2192 \u20ac5",
		"rm\u00a0-rf":   `rm\u{00A0}-rf`, // no-break space: looks like a word break, is not
		"a\u2028b":      `a\u{2028}b`,
		"x\u00adz":      `x\u{00AD}z`,
		"tag\U000E0041": `tag\u{E0041}`,
		"e\u0301":       `e\u{0301}`,
		"\ufeffls":      `\u{FEFF}ls`,
		"bad\xffbyte":   `bad\u{FFFD}byte`,
	}
	for in, want := range cases {
		if got := visibleText(in); got != want {
			t.Errorf("visibleText(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseHookInputIsStrict(t *testing.T) {
	good := `{"session_id":"s","tool_name":"Bash","tool_input":{"command":"ls","description":"d"},"extra":[1,{"a":1}]}`
	in, err := parseHookInput([]byte(good))
	if err != nil || in.SessionID != "s" || in.ToolName != "Bash" {
		t.Fatalf("good input: %+v %v", in, err)
	}
	for name, bad := range map[string]string{
		"duplicate command":          `{"tool_input":{"command":"ls","command":"rm -rf ~"}}`,
		"command in another case":    `{"tool_input":{"command":"ls","Command":"rm -rf ~"}}`,
		"duplicate tool_input":       `{"tool_input":{"command":"ls"},"tool_input":{"command":"rm -rf ~"}}`,
		"tool_input in another case": `{"TOOL_INPUT":{"command":"rm -rf ~"}}`,
		"trailing data":              `{"tool_input":{"command":"ls"}} {"x":1}`,
		"not an object":              `["tool_input"]`,
	} {
		in, err := parseHookInput([]byte(bad))
		if err == nil && len(in.ToolInput) != 0 {
			t.Errorf("%s: accepted %s", name, bad)
		}
	}
}
