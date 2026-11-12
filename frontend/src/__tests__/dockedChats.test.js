import { describe, it, expect } from 'vitest';
import { parseDockedChats, serializeDockedChats, withDockedChat, withoutChat } from '../dockedChats.js';

describe('dockedChats', () => {
  it('reads the old single-chat value as that workspace\'s pin', () => {
    expect(parseDockedChats('{"ns":"team","path":"Chats/a.md"}')).toEqual({ team: { ns: 'team', path: 'Chats/a.md' } });
  });
  it('reads the per-workspace map and drops bad entries', () => {
    const raw = JSON.stringify({ team: { ns: 'team', path: 'a.md' }, ops: { ns: 'other', path: 'b.md' }, x: 3 });
    expect(parseDockedChats(raw)).toEqual({ team: { ns: 'team', path: 'a.md' } });
    expect(parseDockedChats('not json')).toEqual({});
    expect(parseDockedChats(null)).toEqual({});
  });
  it('pins and clears one workspace without touching the others', () => {
    let m = withDockedChat({}, 'team', { ns: 'team', path: 'a.md' });
    m = withDockedChat(m, 'ops', { ns: 'ops', path: 'b.md' });
    expect(Object.keys(m).sort()).toEqual(['ops', 'team']);
    m = withDockedChat(m, 'team', null);
    expect(m).toEqual({ ops: { ns: 'ops', path: 'b.md' } });
  });
  it('drops a deleted chat only where it is pinned', () => {
    const m = { team: { ns: 'team', path: 'a.md' }, ops: { ns: 'ops', path: 'b.md' } };
    expect(withoutChat(m, 'team', 'a.md')).toEqual({ ops: { ns: 'ops', path: 'b.md' } });
    expect(withoutChat(m, 'team', 'other.md')).toBe(m);
  });
  it('stores nothing when nothing is pinned', () => {
    expect(serializeDockedChats({})).toBeNull();
    expect(serializeDockedChats({ team: { ns: 'team', path: 'a.md' } })).toContain('"team"');
  });
});
