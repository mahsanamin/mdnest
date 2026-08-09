import { describe, it, expect } from 'vitest';
import { matchesTaskFilters } from '../taskFilters.js';

const task = (over = {}) => ({ text: 'Design UI', tags: ['design', 'ui'], assignee: 'alice', ...over });

describe('matchesTaskFilters', () => {
  it('passes with no filters', () => {
    expect(matchesTaskFilters(task(), {})).toBe(true);
  });

  it('matches text case-insensitively on the title', () => {
    expect(matchesTaskFilters(task(), { search: 'design' })).toBe(true);
    expect(matchesTaskFilters(task(), { search: 'DESIGN' })).toBe(true);
    expect(matchesTaskFilters(task(), { search: 'backend' })).toBe(false);
  });

  it('matches tags with OR semantics', () => {
    expect(matchesTaskFilters(task(), { tags: ['ui'] })).toBe(true);
    expect(matchesTaskFilters(task(), { tags: ['ui', 'other'] })).toBe(true);
    expect(matchesTaskFilters(task(), { tags: ['backend'] })).toBe(false);
    expect(matchesTaskFilters(task({ tags: [] }), { tags: ['ui'] })).toBe(false);
  });

  it('filters by @me against the current user', () => {
    expect(matchesTaskFilters(task({ assignee: 'olivier' }), { assignee: '@me', currentUser: 'olivier' })).toBe(true);
    expect(matchesTaskFilters(task({ assignee: 'alice' }), { assignee: '@me', currentUser: 'olivier' })).toBe(false);
  });

  it('filters by @unassigned', () => {
    expect(matchesTaskFilters(task({ assignee: '' }), { assignee: '@unassigned' })).toBe(true);
    expect(matchesTaskFilters(task({ assignee: '   ' }), { assignee: '@unassigned' })).toBe(true);
    expect(matchesTaskFilters(task({ assignee: 'alice' }), { assignee: '@unassigned' })).toBe(false);
  });

  it('filters by a specific assignee', () => {
    expect(matchesTaskFilters(task({ assignee: 'bob' }), { assignee: 'bob' })).toBe(true);
    expect(matchesTaskFilters(task({ assignee: 'alice' }), { assignee: 'bob' })).toBe(false);
  });

  it('filters by priority (case-insensitive), empty means any', () => {
    expect(matchesTaskFilters(task({ priority: 'high' }), { priority: 'high' })).toBe(true);
    expect(matchesTaskFilters(task({ priority: 'High' }), { priority: 'high' })).toBe(true);
    expect(matchesTaskFilters(task({ priority: 'low' }), { priority: 'high' })).toBe(false);
    expect(matchesTaskFilters(task({ priority: '' }), { priority: 'high' })).toBe(false);
    expect(matchesTaskFilters(task({ priority: 'low' }), { priority: '' })).toBe(true);
  });

  it('hides tasks in done columns unless showDone is set', () => {
    const done = task({ column: 'done' });
    expect(matchesTaskFilters(done, { showDone: false, doneColumns: ['done'] })).toBe(false);
    expect(matchesTaskFilters(done, { showDone: true, doneColumns: ['done'] })).toBe(true);
    // A non-done column is unaffected by the done filter.
    expect(matchesTaskFilters(task({ column: 'todo' }), { showDone: false, doneColumns: ['done'] })).toBe(true);
    // Default (showDone omitted) keeps done tasks visible — callers opt into hiding.
    expect(matchesTaskFilters(done, { doneColumns: ['done'] })).toBe(true);
  });

  it('filters by relation kind, empty means any', () => {
    const dep = task({ dependsOn: ['Other'] });
    const blk = task({ blockedBy: ['Other'] });
    const rel = task({ relatedTo: ['Other'] });
    const none = task();
    expect(matchesTaskFilters(dep, { relation: 'any' })).toBe(true);
    expect(matchesTaskFilters(none, { relation: 'any' })).toBe(false);
    expect(matchesTaskFilters(dep, { relation: 'depends-on' })).toBe(true);
    expect(matchesTaskFilters(blk, { relation: 'depends-on' })).toBe(false);
    expect(matchesTaskFilters(blk, { relation: 'blocked-by' })).toBe(true);
    expect(matchesTaskFilters(rel, { relation: 'related-to' })).toBe(true);
    expect(matchesTaskFilters(none, { relation: '' })).toBe(true);
  });

  it('combines filters (all must pass)', () => {
    expect(matchesTaskFilters(task(), { search: 'design', tags: ['ui'], assignee: 'alice' })).toBe(true);
    expect(matchesTaskFilters(task(), { search: 'design', tags: ['ui'], assignee: 'bob' })).toBe(false);
  });

  it('filters by due-date window against a fixed today', () => {
    const today = '2026-08-09';
    const overdue = task({ due: '2026-08-01' });
    const dueToday = task({ due: today });
    const inWeek = task({ due: '2026-08-14' });
    const inMonth = task({ due: '2026-09-01' });
    const far = task({ due: '2027-01-01' });
    const noDue = task({ due: '' });

    expect(matchesTaskFilters(overdue, { due: 'overdue', today })).toBe(true);
    expect(matchesTaskFilters(dueToday, { due: 'overdue', today })).toBe(false);
    // A completed overdue task is not "overdue" for the filter.
    expect(matchesTaskFilters(task({ due: '2026-08-01', checked: true }), { due: 'overdue', today })).toBe(false);

    expect(matchesTaskFilters(dueToday, { due: 'today', today })).toBe(true);
    expect(matchesTaskFilters(overdue, { due: 'today', today })).toBe(false);

    expect(matchesTaskFilters(inWeek, { due: 'week', today })).toBe(true);
    expect(matchesTaskFilters(inMonth, { due: 'week', today })).toBe(false);
    expect(matchesTaskFilters(overdue, { due: 'week', today })).toBe(false); // past, not upcoming

    expect(matchesTaskFilters(inMonth, { due: 'month', today })).toBe(true);
    expect(matchesTaskFilters(far, { due: 'month', today })).toBe(false);

    expect(matchesTaskFilters(dueToday, { due: 'has', today })).toBe(true);
    expect(matchesTaskFilters(noDue, { due: 'has', today })).toBe(false);
    expect(matchesTaskFilters(noDue, { due: 'none', today })).toBe(true);
    expect(matchesTaskFilters(dueToday, { due: 'none', today })).toBe(false);
  });
});
