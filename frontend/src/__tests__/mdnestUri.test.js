import { describe, it, expect } from 'vitest';
import { mdnestUri } from '../mdnestUri.js';
import { chatMenuGroups } from '../contextMenuItems.js';

describe('mdnestUri', () => {
  it('builds the address the CLI takes, with the alias', () => {
    expect(mdnestUri('mini', 'notes', 'Chats/team.md')).toBe('mdnest://@mini/notes/Chats/team.md');
  });
  it('leaves out the alias when the server has none', () => {
    expect(mdnestUri('', 'notes', 'a.md')).toBe('mdnest://notes/a.md');
  });
  it('encodes each segment so a space cannot split the address, keeping slashes', () => {
    expect(mdnestUri('mini', 'my notes', 'Daily/19 Jun 2026.md')).toBe('mdnest://@mini/my%20notes/Daily/19%20Jun%202026.md');
  });
});

describe('chat list menu', () => {
  const labels = (g) => g.map((x) => x.map((i) => i.label));
  it('open as note, copy path, and Delete last when allowed', () => {
    expect(labels(chatMenuGroups({ canDelete: true }))).toEqual([['Connect an agent…'], ['Open as note'], ['Copy path for CLI'], ['Delete chat']]);
  });
  it('no Delete without the right', () => {
    expect(labels(chatMenuGroups({ canDelete: false }))).toEqual([['Connect an agent…'], ['Open as note'], ['Copy path for CLI']]);
  });
  it('Members only where a chat can have members (multi mode)', () => {
    expect(labels(chatMenuGroups({ canMembers: true }))[0]).toEqual(['Members…', 'Connect an agent…']);
  });
});
