// Agent approvals (experimental, ENABLE_AGENT_APPROVALS): the card in a chat,
// the badge and tab title count, Allow / Deny with a reason, and the states
// with no buttons (answered in the terminal, unknown request).
//
// The harness runs single mode, so there is one account. "Another account
// sees no buttons" is the same path as an unknown id here: the server answers
// 404 for both, and the card then shows no buttons. The per-account rules are
// pinned against the real auth middleware in backend/routes_approvals_test.go.
import { test, expect } from '@playwright/test';

const USER = process.env.MDNEST_USER || 'e2e';
const PASS = process.env.MDNEST_PASSWORD || 'e2epass123';
const NS = process.env.MDNEST_TEST_NS || 'testing_workspace';

async function api(page, method, url, body, token) {
  return page.evaluate(async ([m, u, b, tok]) => {
    const t = tok || localStorage.getItem('mdnest_token');
    const r = await fetch(u, { method: m, headers: { Authorization: 'Bearer ' + t }, body: b });
    return { status: r.status, text: await r.text() };
  }, [method, url, body, token || null]);
}

async function signIn(page) {
  await page.goto('/');
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PASS);
  await page.click('button:has-text("Sign in")');
  await page.locator('.toolbar-view-chats').waitFor({ state: 'visible', timeout: 15_000 });
  const cfg = await api(page, 'GET', '/api/config');
  if (!JSON.parse(cfg.text).agentApprovals) test.skip(true, 'agent approvals disabled (ENABLE_AGENT_APPROVALS)');
}

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function seedChat(page) {
  const chat = `__approval-${uid()}-room.md`;
  expect((await api(page, 'POST', `/api/chat/convert?ns=${NS}&path=${encodeURIComponent(chat)}&title=Approvals`)).status).toBe(201);
  return chat;
}

async function ask(page, { chat, command, description = 'Push the branch', session = uid() }) {
  const input = JSON.stringify({
    session_id: session, cwd: '/work/repo', hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: { command, description },
  });
  const q = `cli=4.8.5&agent=claude-code&machine=e2e-box${chat ? `&chat=${encodeURIComponent(`${NS}/${chat}`)}` : ''}`;
  const r = await api(page, 'POST', `/api/approvals?${q}`, input);
  expect(r.status).toBe(201);
  return { id: JSON.parse(r.text).id, session };
}

// Leave nothing pending for the next test's badge count.
async function closeAll(page) {
  const r = await api(page, 'GET', '/api/approvals');
  for (const a of JSON.parse(r.text).approvals || []) {
    await api(page, 'POST', `/api/approvals/${a.id}/decide`, JSON.stringify({ decision: 'deny' }));
  }
}

test.describe('agent approvals', () => {
  // One account, one badge count: these tests must not overlap.
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(async ({ page }) => { await signIn(page); await closeAll(page); });
  test.afterEach(async ({ page }) => { await closeAll(page); });

  test('a card in the chat shows the command, and Allow answers the agent', async ({ page }) => {
    const chat = await seedChat(page);
    const { id } = await ask(page, { chat, command: 'git push origin feat/x' });

    // The note itself holds only the marker and a neutral line.
    const note = await api(page, 'GET', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`);
    expect(note.text).toContain(`approval:${id}`);
    expect(note.text).toContain('Claude Code on e2e-box is waiting for approval.');
    expect(note.text).not.toContain('git push');

    await page.goto(`/#!chats/${NS}/${chat}`);
    const card = page.getByTestId('approval-card');
    await expect(card).toHaveAttribute('data-state', 'pending');
    await expect(card.getByTestId('approval-command')).toHaveText('git push origin feat/x');
    await expect(card).toContainText('The agent describes it as: Push the branch');
    await expect(card).toContainText('e2e-box');

    // The badge and the tab title count it while it waits.
    await expect(page.getByTestId('approvals-badge')).toHaveText('1 waiting', { timeout: 10_000 });
    await expect(page).toHaveTitle(/^\(1\) /);

    await card.getByRole('button', { name: 'Allow', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'allowed');
    await expect(card.getByTestId('approval-state')).toContainText('Allowed by');
    await expect(card.getByRole('button')).toHaveCount(0);

    const wait = await api(page, 'GET', `/api/approvals/${id}/wait`);
    expect(wait.status).toBe(200);
    expect(JSON.parse(wait.text)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await expect(page.getByTestId('approvals-badge')).toHaveCount(0, { timeout: 10_000 });
    await expect(page).not.toHaveTitle(/^\(\d+\) /);
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`);
  });

  test('Deny with a reason passes the reason to the agent', async ({ page }) => {
    const chat = await seedChat(page);
    const { id } = await ask(page, { chat, command: 'make deploy' });
    await page.goto(`/#!chats/${NS}/${chat}`);
    const card = page.getByTestId('approval-card');
    await card.getByRole('button', { name: 'Deny with a reason' }).click();
    await card.getByLabel('Reason for denying').fill('Run the tests first');
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(card).toHaveAttribute('data-state', 'denied');
    await expect(card).toContainText('Run the tests first');
    const wait = await api(page, 'GET', `/api/approvals/${id}/wait`);
    expect(JSON.parse(wait.text).hookSpecificOutput.decision).toEqual({ behavior: 'deny', message: 'Run the tests first' });
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`);
  });

  test('an API token cannot decide, and a request answered in the terminal loses its buttons', async ({ page }) => {
    const chat = await seedChat(page);
    const { id, session } = await ask(page, { chat, command: 'npm publish' });
    const minted = await api(page, 'POST', '/api/auth/tokens', JSON.stringify({ name: `e2e-approvals-${uid()}` }));
    const token = JSON.parse(minted.text).token;
    expect(token).toMatch(/^mdnest_/);
    const refused = await api(page, 'POST', `/api/approvals/${id}/decide`, JSON.stringify({ decision: 'allow' }), token);
    expect(refused.status).toBe(403);

    await page.goto(`/#!chats/${NS}/${chat}`);
    const card = page.getByTestId('approval-card');
    await expect(card).toHaveAttribute('data-state', 'pending');
    // The agent's PostToolUse hook (`mdnest approval done`) after the person
    // answered in the terminal.
    const done = JSON.stringify({ session_id: session, hook_event_name: 'Stop' });
    expect((await api(page, 'POST', `/api/approvals/close?session=${session}`, done, token)).status).toBe(200);
    await expect(card).toHaveAttribute('data-state', 'closed', { timeout: 10_000 });
    await expect(card).toContainText('Answered in the terminal');
    await expect(card.getByRole('button')).toHaveCount(0);
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`);
  });

  test('a card for a request this account cannot see has no buttons', async ({ page }) => {
    const chat = await seedChat(page);
    const fake = '0123456789abcdef0123456789abcdef';
    await api(page, 'POST', `/api/chat?ns=${NS}&path=${encodeURIComponent(chat)}&as=claude-code`,
      `![approval](approval:${fake})\n\nClaude Code on elsewhere is waiting for approval.`);
    await page.goto(`/#!chats/${NS}/${chat}`);
    await expect(page.locator('.chat-approval-text')).toContainText('Claude Code on elsewhere is waiting for approval.');
    const card = page.getByTestId('approval-card');
    await expect(card).toHaveAttribute('data-state', 'gone');
    await expect(card.getByRole('button')).toHaveCount(0);
    await api(page, 'DELETE', `/api/note?ns=${NS}&path=${encodeURIComponent(chat)}`);
  });

  test('a request with no chat shows in the approvals list', async ({ page }) => {
    await ask(page, { command: 'terraform apply' });
    await page.goto('/');
    const badge = page.getByTestId('approvals-badge');
    await expect(badge).toHaveText('1 waiting', { timeout: 10_000 });
    await badge.click();
    const panel = page.getByRole('dialog', { name: 'Agent approvals' });
    await expect(panel.getByTestId('approval-command')).toHaveText('terraform apply');
    await panel.getByRole('button', { name: 'Deny', exact: true }).click();
    // Decided, so it leaves the list of what is waiting.
    await expect(panel.getByTestId('approval-card')).toHaveCount(0, { timeout: 10_000 });
    await expect(panel).toContainText('Nothing is waiting for you.');
    await expect(badge).toHaveCount(0, { timeout: 10_000 });
  });
});
