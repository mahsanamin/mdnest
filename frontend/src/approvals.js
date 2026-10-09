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
  const who = a.agentName || a.agent || 'An agent';
  const where = a.machine ? ` on ${a.machine}` : '';
  return `${who}${where} is waiting for approval`;
}

// What a decided, expired or closed card says instead of its buttons.
export function stateText(a) {
  if (!a) return '';
  const when = a.decidedAt ? ` at ${new Date(a.decidedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}` : '';
  switch (a.state) {
    case 'allowed': return `Allowed by ${a.decidedBy || 'you'}${when}`;
    case 'denied': return `Denied by ${a.decidedBy || 'you'}${when}${a.reason ? `: ${a.reason}` : ''}`;
    case 'closed': return `Answered in the terminal${when}`;
    case 'expired': return 'Expired. Nobody answered here, so the agent asks in its terminal.';
    default: return '';
  }
}

export const MAX_DENY_REASON = 500;
