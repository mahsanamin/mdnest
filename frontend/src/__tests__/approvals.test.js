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
