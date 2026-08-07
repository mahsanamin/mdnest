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

  it('combines filters (all must pass)', () => {
    expect(matchesTaskFilters(task(), { search: 'design', tags: ['ui'], assignee: 'alice' })).toBe(true);
    expect(matchesTaskFilters(task(), { search: 'design', tags: ['ui'], assignee: 'bob' })).toBe(false);
  });
});
