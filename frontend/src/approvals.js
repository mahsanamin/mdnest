// Agent approvals (experimental, ENABLE_AGENT_APPROVALS). Pure helpers, no
// React: the chat card marker, the tab title count, and which requests are
// new since the last poll (one browser notification each).
//
// A chat message carries only a marker and a neutral line:
//   ![approval](approval:<32 hex>)
//   Claude Code on build-box is waiting for approval.
// The command, the description and the buttons come from
// GET /api/approvals/<id>, which only the owner can read. A chat is a file
// every member reads and git keeps, so the command is never written into it.

export const APPROVALS_POLL_MS = 5000;
export const APPROVAL_CARD_POLL_MS = 3000;

const MARKER_RE = /!\[[^\]\n]*\]\(approval:([0-9a-f]{32})\)/;
const MARKER_RE_G = /!\[[^\]\n]*\]\(approval:([0-9a-f]{32})\)/g;

// The approval id a message carries, or null.
export function approvalIdIn(text) {
  const m = MARKER_RE.exec(String(text || ''));
  return m ? m[1] : null;
}

// The message without its marker, so the rest renders as ordinary markdown.
export function withoutApprovalMarker(text) {
  return String(text || '').replace(MARKER_RE_G, '').replace(/^\s+/, '');
}

// "(2) mdnest (home)" while two requests wait, the plain title otherwise.
export function titleWithCount(base, count) {
  return count > 0 ? `(${count}) ${base}` : base;
}

// The requests in `list` whose ids are not in `seen` (a Set), oldest first.
export function newApprovals(seen, list) {
  return (list || []).filter((a) => a && a.id && !seen.has(a.id));
}

// One line for the browser notification.
export function notificationText(a) {
  if (a.text) return a.text; // a notice says it already
  const who = a.label || `${a.agentName || a.agent || 'An agent'}${a.machine ? ` on ${a.machine}` : ''}`;
  return `${who} ${a.questions ? 'has a question' : 'is waiting for approval'}`;
}

// shortPath shows a file the agent touches the way a person reads it:
// relative to the agent's folder when it is inside it, else with the agent's
// own home folder as ~. It never hides anything that changes where the file
// is: a path with a "." or ".." segment, an empty segment, or a backslash is
// shown in full, and only the home folder the agent's own cwd is in becomes ~
// (another user's home stays spelled out).
export function hasTrickySegments(path) {
  const p = String(path || '');
  return /\\/.test(p) || p.split('/').slice(1).some((seg) => seg === '' || seg === '.' || seg === '..');
}

export function homeOf(cwd) {
  const m = /^\/(?:Users|home)\/[^/]+/.exec(String(cwd || ''));
  return m && !hasTrickySegments(m[0]) ? m[0] : '';
}

export function shortPath(path, cwd) {
  const p = String(path || '');
  if (!p.startsWith('/') || hasTrickySegments(p)) return p;
  const c = String(cwd || '').replace(/\/+$/, '');
  if (c && !hasTrickySegments(c) && p.startsWith(c + '/')) return p.slice(c.length + 1);
  return tildePath(p, cwd);
}

export function tildePath(path, cwd) {
  const p = String(path || '');
  const home = homeOf(cwd);
  if (!home || hasTrickySegments(p)) return p;
  if (p === home) return '~';
  return p.startsWith(home + '/') ? '~' + p.slice(home.length) : p;
}

// middleEllipsis keeps both ends of a long text readable on a narrow screen.
// Only for context (the folder the agent runs in), never for what is being
// approved: the approved path is shown whole and wraps.
export function middleEllipsis(s, max = 48) {
  const t = String(s || '');
  if (t.length <= max) return t;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return t.slice(0, head) + '…' + t.slice(t.length - (keep - head));
}

export const PREVIEW_LINES = 40;

// firstLines splits long content for a preview: the first `n` lines, and how
// many more there are.
export function firstLines(text, n = PREVIEW_LINES) {
  const lines = String(text || '').split('\n');
  if (lines.length <= n) return { shown: String(text || ''), more: 0 };
  return { shown: lines.slice(0, n).join('\n'), more: lines.length - n };
}

// An answer is ready to send when every question has one: single-select
// questions take exactly one of a pick or typed text.
export function answersComplete(questions, answers) {
  return (questions || []).every((q, i) => {
    const a = answers[i] || { selected: [], other: '' };
    const n = a.selected.length + (a.other.trim() ? 1 : 0);
    return q.multiSelect ? n >= 1 : n === 1;
  });
}

// toggleChoice updates one question's answer after a click on option `idx`.
// A single-select pick replaces the previous one and clears typed text.
export function toggleChoice(q, a, idx) {
  const cur = a || { selected: [], other: '' };
  if (!q.multiSelect) return { selected: [idx], other: '' };
  const has = cur.selected.includes(idx);
  return { ...cur, selected: has ? cur.selected.filter((i) => i !== idx) : [...cur.selected, idx].sort((x, y) => x - y) };
}

// What a decided, expired or closed card says instead of its buttons.
export function stateText(a) {
  if (!a) return '';
  const when = a.decidedAt ? ` at ${new Date(a.decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
  switch (a.state) {
    case 'allowed':
      if (a.answer) return `Answered by ${a.decidedBy || 'you'}${when}`;
      return `Allowed${a.forSession ? ' for this session' : ''} by ${a.decidedBy || 'you'}${when}`;
    case 'denied': return `Denied by ${a.decidedBy || 'you'}${when}${a.reason ? `: ${a.reason}` : ''}`;
    case 'closed': return `Answered in the terminal${when}`;
    case 'expired': return 'Expired. Nobody answered here, so the agent asks in its terminal.';
    default: return '';
  }
}

export const MAX_DENY_REASON = 500;
