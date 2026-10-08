import { describe, it, expect } from 'vitest';
import { pinKey, parsePins, togglePin, chatsForTab } from '../chat.js';
import { chatMenuGroups } from '../contextMenuItems.js';

const chats = [
  { ns: 'w', path: 'Chats/a.md', title: 'a' },
  { ns: 'w', path: 'Chats/b.md', title: 'b' },
  { ns: 'w', path: 'Chats/c.md', title: 'c' },
];

describe('pinned chats', () => {
  it('a new pin goes first; pinning again unpins', () => {
    let p = togglePin([], pinKey('w', 'Chats/a.md'));
    p = togglePin(p, pinKey('w', 'Chats/c.md'));
    expect(p).toEqual(['w/Chats/c.md', 'w/Chats/a.md']);
    expect(togglePin(p, 'w/Chats/c.md')).toEqual(['w/Chats/a.md']);
  });
  it('Pinned shows pinned chats in pin order; All shows everything', () => {
    const pins = ['w/Chats/c.md', 'other/Chats/x.md', 'w/Chats/a.md'];
    expect(chatsForTab(chats, pins, 'pinned').map((c) => c.title)).toEqual(['c', 'a']);
    expect(chatsForTab(chats, pins, 'all')).toBe(chats);
  });
  it('a broken or hand-edited value reads as no pins, never throws', () => {
    expect(parsePins('')).toEqual([]);
    expect(parsePins('not json')).toEqual([]);
    expect(parsePins('{"a":1}')).toEqual([]);
    expect(parsePins('["w/a.md", 3, "", null]')).toEqual(['w/a.md']);
  });
  it('the right-click menu offers pin or unpin, and nothing if pins did not load', () => {
    const first = (g) => g[0][0].label;
    expect(first(chatMenuGroups({ pinned: false }))).toBe('Pin to the Pinned tab');
    expect(first(chatMenuGroups({ pinned: true }))).toBe('Unpin');
    expect(first(chatMenuGroups({}))).toBe('Connect an agent…');
  });
});
