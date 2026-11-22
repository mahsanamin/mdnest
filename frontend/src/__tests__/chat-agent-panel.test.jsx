// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { getChat, saveChatAgentRole } from '../api.js';

vi.mock('../api.js', async (original) => ({ ...await original(), getChat: vi.fn(), saveChatAgentRole: vi.fn() }));
const { ChatAgentPanel } = await import('../components/ChatView.jsx');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host, root, roles;
beforeEach(async () => {
  vi.useFakeTimers();
  roles = {};
  getChat.mockImplementation(async () => ({ agents: { ...roles } }));
  saveChatAgentRole.mockImplementation(async (_ns, _path, name, role) => { roles[name] = role; });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ChatAgentPanel chat={{ ns: 'notes', path: 'team.md' }} serverAlias="local" onClose={() => {}} />));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.clearAllMocks(); });
it('refreshes a role saved through the CLI while Agents is already open', async () => {
  roles.builder = 'Review the implementation';
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
  expect(host.querySelector('[data-testid=chat-agent-saved]')?.textContent).toContain('builder');
  expect(host.textContent).toContain('Review the implementation');
});
it('loads an existing prompt for editing and saves it without copying', async () => {
  roles.builder = 'Review "quotes"\nand a second line';
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
  const edit = host.querySelector('[aria-label="Edit builder\'s prompt"]');
  expect(edit).not.toBeNull();
  await act(async () => edit.click());
  expect(host.querySelector('[aria-label="Agent name"]').value).toBe('builder');
  expect(host.querySelector('[aria-label="What this agent should do"]').value).toBe(roles.builder);
  roles.builder = 'Changed through CLI while this form stays open';
  await act(async () => { await vi.advanceTimersByTimeAsync(3100); });
  expect(host.querySelector('[aria-label="What this agent should do"]').value).toBe('Review "quotes"\nand a second line');
  const save = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Save prompt');
  await act(async () => save.click());
  expect(saveChatAgentRole).toHaveBeenCalledWith('notes', 'team.md', 'builder', 'Review "quotes"\nand a second line');
});
