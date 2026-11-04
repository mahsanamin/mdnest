import { describe, it, expect } from 'vitest';
import { parseRoute, formatRoute, noteLink } from '../hashRoute';

describe('hash routes', () => {
  it('a note round-trips, including characters that need encoding', () => {
    const r = { ns: 'my notes', path: 'a b/c#d.md', stickies: false, board: false };
    expect(parseRoute(formatRoute(r))).toEqual(r);
  });
  it('the task board keeps its namespace and the note underneath', () => {
    const h = formatRoute({ ns: 'bigproject', path: 'boardscroll-1.md', board: true });
    expect(h).toBe('#!board/bigproject/boardscroll-1.md');
    expect(parseRoute(h)).toEqual({ ns: 'bigproject', path: 'boardscroll-1.md', stickies: false, board: true });
  });
  it('the task board without a note', () => {
    expect(formatRoute({ ns: 'bigproject', board: true })).toBe('#!board/bigproject');
    expect(parseRoute('#!board/bigproject')).toEqual({ ns: 'bigproject', path: null, stickies: false, board: true });
  });
  it('the milestones of a board, and one milestone page, to share', () => {
    expect(formatRoute({ ns: 'my notes', path: 'x.md', board: true, milestone: '' })).toBe('#!milestones/my%20notes');
    expect(formatRoute({ ns: 'ops', board: true, milestone: 'm1-ci' })).toBe('#!milestones/ops/m1-ci');
    expect(parseRoute('#!milestones/my%20notes')).toEqual({ ns: 'my notes', path: null, stickies: false, board: true, milestone: '' });
    expect(parseRoute('#!milestones/ops/m1-ci')).toEqual({ ns: 'ops', path: null, stickies: false, board: true, milestone: 'm1-ci' });
    // Without a milestone value the board keeps its own route.
    expect(formatRoute({ ns: 'ops', board: true, milestone: null })).toBe('#!board/ops');
  });
  it('a namespace literally called "board" or "stickies" is still a note route', () => {
    expect(parseRoute('#board/x.md')).toEqual({ ns: 'board', path: 'x.md', stickies: false, board: false });
    expect(parseRoute('#stickies')).toEqual({ ns: 'stickies', path: null, stickies: false, board: false });
  });
  it('the sticky board route is unchanged', () => {
    expect(formatRoute({ stickies: true, ns: 'x', board: true })).toBe('#!stickies');
    expect(parseRoute('#!stickies').stickies).toBe(true);
  });
  it('an empty hash is nothing', () => {
    expect(parseRoute('')).toEqual({ ns: null, path: null, stickies: false, board: false });
  });
  it('the chats view round-trips, with and without an open chat', () => {
    expect(formatRoute({ chats: true })).toBe('#!chats');
    expect(parseRoute('#!chats')).toMatchObject({ chats: true, chat: null, board: false, stickies: false });
    const h = formatRoute({ chats: true, chat: { ns: 'my notes', path: 'Chats/q4 plan.md' }, ns: 'other' });
    expect(h).toBe('#!chats/my%20notes/Chats/q4%20plan.md');
    expect(parseRoute(h).chat).toEqual({ ns: 'my notes', path: 'Chats/q4 plan.md' });
  });
  it('a namespace literally called "chats" is still a note route', () => {
    expect(parseRoute('#chats/x.md')).toEqual({ ns: 'chats', path: 'x.md', stickies: false, board: false });
  });
});

describe('browser link (Copy browser link)', () => {
  const base = 'https://notes.example.com/sub/';
  const cases = [
    ['team', 'Specs/api.md'],
    ['my notes', 'a b/19 Jun 2026.md'],
    ['ns', 'C# tips/#1 #hash.md'],
    ['ns', '100% done/50%25.md'],
    ['ns', 'why?/a?b=c&d.md'],
    ['équipe', 'Réunions/会议 …/naïve 😀.md'],
  ];
  for (const [ns, path] of cases) {
    it(`round-trips ${ns}/${path}`, () => {
      const link = noteLink(base, ns, path);
      // The base is kept as is, and the rest is a hash the app parses back.
      expect(link.startsWith(base + '#')).toBe(true);
      const hash = link.slice(base.length);
      expect(parseRoute(hash)).toEqual({ ns, path, stickies: false, board: false });
      // A URL parser sees the same hash: no raw "#" or "?" leaks out of a name.
      expect(new URL(link).hash).toBe(hash);
      expect(new URL(link).search).toBe('');
    });
  }
});
