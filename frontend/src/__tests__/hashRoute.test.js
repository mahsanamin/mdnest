import { describe, it, expect } from 'vitest';
import { parseRoute, formatRoute } from '../hashRoute';

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
