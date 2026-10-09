import { describe, it, expect } from 'vitest';
import { approvalIdIn, withoutApprovalMarker, titleWithCount, newApprovals, notificationText, stateText } from '../approvals.js';

const ID = '0123456789abcdef0123456789abcdef';
const MSG = `![approval](approval:${ID})\n\nClaude Code on build-box is waiting for approval.`;

describe('approval marker', () => {
  it('finds the id in a card message', () => {
    expect(approvalIdIn(MSG)).toBe(ID);
  });
  it('ignores anything that is not a 128-bit hex id', () => {
    expect(approvalIdIn('![approval](approval:xyz)')).toBeNull();
    expect(approvalIdIn('![approval](approval:0123)')).toBeNull();
    expect(approvalIdIn('just text')).toBeNull();
    expect(approvalIdIn(`\`![approval](approval:${ID.toUpperCase()})\``)).toBeNull();
  });
  it('leaves the readable line when the marker is removed', () => {
    expect(withoutApprovalMarker(MSG)).toBe('Claude Code on build-box is waiting for approval.');
  });
});

describe('tab title', () => {
  it('shows the count only while something waits', () => {
    expect(titleWithCount('mdnest', 0)).toBe('mdnest');
    expect(titleWithCount('mdnest (home)', 2)).toBe('(2) mdnest (home)');
  });
});

describe('notifications', () => {
  it('reports only requests not seen before', () => {
    const seen = new Set(['a']);
    expect(newApprovals(seen, [{ id: 'a' }, { id: 'b' }]).map((x) => x.id)).toEqual(['b']);
  });
  it('names the agent and the machine, never the command', () => {
    const text = notificationText({ agentName: 'Codex', machine: 'box', command: 'rm -rf x' });
    expect(text).toBe('Codex on box is waiting for approval');
    expect(text).not.toContain('rm');
  });
});

describe('card state text', () => {
  it('says who decided', () => {
    expect(stateText({ state: 'allowed', decidedBy: 'pat' })).toBe('Allowed by pat');
    expect(stateText({ state: 'denied', decidedBy: 'pat', reason: 'not now' })).toBe('Denied by pat: not now');
  });
  it('explains expiry and a terminal answer', () => {
    expect(stateText({ state: 'expired' })).toMatch(/Expired/);
    expect(stateText({ state: 'closed' })).toMatch(/Answered in the terminal/);
  });
});

import { shortPath, tildePath, middleEllipsis, firstLines, answersComplete, toggleChoice } from '../approvals.js';

describe('paths on the card', () => {
  it('is relative inside the agent folder, ~ outside it', () => {
    expect(shortPath('/Users/pat/repo/src/a.go', '/Users/pat/repo')).toBe('src/a.go');
    expect(shortPath('/Users/pat/other/a.go', '/Users/pat/repo')).toBe('~/other/a.go');
    expect(shortPath('/home/pat/x', '')).toBe('~/x');
    expect(shortPath('/etc/hosts', '/Users/pat/repo')).toBe('/etc/hosts');
    expect(tildePath('/Users/pat')).toBe('~');
  });
  it('keeps both ends of a long path', () => {
    const s = middleEllipsis('a'.repeat(30) + 'b'.repeat(30), 21);
    expect(s).toHaveLength(21);
    expect(s.startsWith('aaaaaaaaaa')).toBe(true);
    expect(s.endsWith('bbbbbbbbbb')).toBe(true);
    expect(middleEllipsis('short', 21)).toBe('short');
  });
  it('previews the first 40 lines and counts the rest', () => {
    const text = Array.from({ length: 45 }, (_, i) => `l${i}`).join('\n');
    const p = firstLines(text);
    expect(p.shown.split('\n')).toHaveLength(40);
    expect(p.more).toBe(5);
    expect(firstLines('a\nb').more).toBe(0);
  });
});

describe('question answers', () => {
  const single = { multiSelect: false, options: [{}, {}] };
  const multi = { multiSelect: true, options: [{}, {}, {}] };
  it('single select replaces the pick', () => {
    expect(toggleChoice(single, { selected: [0], other: 'x' }, 1)).toEqual({ selected: [1], other: '' });
  });
  it('multi select toggles, in option order', () => {
    let a = toggleChoice(multi, undefined, 2);
    a = toggleChoice(multi, a, 0);
    expect(a.selected).toEqual([0, 2]);
    expect(toggleChoice(multi, a, 2).selected).toEqual([0]);
  });
  it('is complete only when every question has a valid answer', () => {
    expect(answersComplete([single, multi], [{ selected: [0], other: '' }, { selected: [], other: 'x' }])).toBe(true);
    expect(answersComplete([single], [{ selected: [0], other: 'x' }])).toBe(false);
    expect(answersComplete([multi], [{ selected: [], other: ' ' }])).toBe(false);
  });
});

describe('notifications for notices and questions', () => {
  it('uses the notice text, or says a question waits', () => {
    expect(notificationText({ text: 'Builder stopped' })).toBe('Builder stopped');
    expect(notificationText({ label: 'Builder (Claude Code on mini)', questions: [{}] })).toBe('Builder (Claude Code on mini) has a question');
  });
});
