import { describe, it, expect } from 'vitest';
import { sortTasks, compareUrgency, dueRank, priorityRank } from '../task-sort.js';

const t = (over) => ({ path: 'a.md', line: 1, ...over });

describe('task ordering', () => {
  it('leaves the list untouched in note order — the default must not reshuffle boards', () => {
    const list = [t({ path: 'z.md', due: '2020-01-01' }), t({ path: 'a.md' })];
    expect(sortTasks(list, 'note')).toBe(list);
  });

  it('does not mutate the caller\'s array', () => {
    const list = [t({ path: 'z.md' }), t({ path: 'a.md', due: '2020-01-01' })];
    const copy = [...list];
    sortTasks(list, 'urgency');
    expect(list).toEqual(copy);
  });

  it('puts the soonest due date first', () => {
    const out = sortTasks([
      t({ path: 'c.md', due: '2026-12-01' }),
      t({ path: 'a.md', due: '2026-01-01' }),
      t({ path: 'b.md', due: '2026-06-01' }),
    ], 'urgency');
    expect(out.map((x) => x.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('sorts undated tasks after dated ones, by priority', () => {
    const out = sortTasks([
      t({ path: 'low.md', priority: 'low' }),
      t({ path: 'dated.md', due: '2030-01-01' }),
      t({ path: 'high.md', priority: 'high' }),
    ], 'urgency');
    expect(out.map((x) => x.path)).toEqual(['dated.md', 'high.md', 'low.md']);
  });

  it('breaks ties by note and line, so the order is stable between renders', () => {
    const out = sortTasks([
      t({ path: 'b.md', line: 1, due: '2026-01-01' }),
      t({ path: 'a.md', line: 9, due: '2026-01-01' }),
      t({ path: 'a.md', line: 2, due: '2026-01-01' }),
    ], 'urgency');
    expect(out.map((x) => `${x.path}:${x.line}`)).toEqual(['a.md:2', 'a.md:9', 'b.md:1']);
  });

  it('treats a malformed due date as no date rather than as urgent', () => {
    expect(dueRank('not-a-date')).toBe(Number.POSITIVE_INFINITY);
    expect(dueRank('')).toBe(Number.POSITIVE_INFINITY);
    const out = sortTasks([t({ path: 'bad.md', due: 'soon-ish' }), t({ path: 'real.md', due: '2026-01-01' })], 'urgency');
    expect(out[0].path).toBe('real.md');
  });

  it('ranks unknown priorities below the known ones', () => {
    expect(priorityRank('high')).toBeLessThan(priorityRank('low'));
    expect(priorityRank('banana')).toBeGreaterThan(priorityRank('low'));
    expect(priorityRank(undefined)).toBeGreaterThan(priorityRank('low'));
  });

  it('compareUrgency is symmetric', () => {
    const a = t({ path: 'a.md', due: '2026-01-01' });
    const b = t({ path: 'b.md', priority: 'high' });
    expect(Math.sign(compareUrgency(a, b))).toBe(-Math.sign(compareUrgency(b, a)));
  });
});
