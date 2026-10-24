import { describe, it, expect } from 'vitest';
import { milestoneProgress, milestoneStats, dueLabel, sortMilestones, milestoneId, milestoneLabel, formatCreated } from '../milestones';
import { matchesTaskFilters } from '../taskFilters';

const tasks = [
  { milestone: 'm1', column: 'todo' },
  { milestone: 'm1', column: 'done', checked: true },
  { milestone: 'm1', column: 'review' },
  { milestone: 'm2', column: 'todo' },
  { column: 'todo' },
];

describe('milestoneProgress', () => {
  it('counts only the tasks of the milestone, done by column or checkbox', () => {
    expect(milestoneProgress({ id: 'm1' }, tasks, ['done', 'review'], '2026-10-23'))
      .toEqual({ total: 3, done: 2, open: 1, percent: 67, overdue: false });
  });

  it('is overdue only while open work remains past the due date', () => {
    const late = { id: 'm1', due: '2026-10-01' };
    expect(milestoneProgress(late, tasks, ['done'], '2026-10-23').overdue).toBe(true);
    expect(milestoneProgress({ ...late, closed: true }, tasks, ['done'], '2026-10-23').overdue).toBe(false);
    expect(milestoneProgress(late, tasks, ['done', 'todo', 'review'], '2026-10-23').overdue).toBe(false);
  });

  it('reports an empty milestone as 0 %', () => {
    expect(milestoneProgress({ id: 'none' }, tasks, ['done'])).toMatchObject({ total: 0, percent: 0 });
  });
});

describe('milestoneStats', () => {
  const ms = { id: 'm1', start: '2026-10-01', due: '2026-10-31' };
  const work = [
    { milestone: 'm1', column: 'done', checked: true, assignee: 'ann', createdBy: 'bob', created: '2026-09-30T10:00:00Z' },
    { milestone: 'm1', column: 'doing', assignee: 'ann', createdBy: 'ann', created: '2026-10-05T10:00:00Z',
      steps: [{ checked: true }, { checked: true }, { checked: false }, { checked: false }], due: '2026-10-10' },
    { milestone: 'm1', column: 'todo', createdBy: 'bob', created: '2026-10-01T23:00:00Z', ref: 'X-1' },
    { milestone: 'other', column: 'todo', assignee: 'zed' },
  ];
  const s = milestoneStats(ms, work, { doneColumns: ['done'], today: '2026-10-16', isBlocked: (t) => t.ref === 'X-1' });

  it('weighs open tasks by their done steps, next to the raw counters', () => {
    // (1 + 2/4 + 0) / 3 = 50 %; tasks 1/3; steps 2/4.
    expect(s).toMatchObject({ total: 3, done: 1, open: 2, percent: 50, taskPercent: 33, steps: 4, stepsDone: 2 });
    expect(s.byColumn).toEqual({ done: 1, doing: 1, todo: 1 });
  });

  it('compares the time elapsed with the work done', () => {
    // 15 of 30 days gone, 50 % done: on track.
    expect(s).toMatchObject({ timePercent: 50, daysLeft: 15, late: false, behind: false });
    const later = milestoneStats(ms, work, { doneColumns: ['done'], today: '2026-10-28' });
    expect(later).toMatchObject({ timePercent: 90, behind: true, late: false });
    expect(milestoneStats(ms, work, { doneColumns: ['done'], today: '2026-11-02' })).toMatchObject({ timePercent: 100, daysLeft: -2, late: true });
  });

  it('lists the tasks needing attention and those added after the start', () => {
    expect(s.overdue.map((t) => t.due)).toEqual(['2026-10-10']);
    expect(s.blocked.map((t) => t.ref)).toEqual(['X-1']);
    // Created on the start day is not "after".
    expect(s.addedAfterStart.map((t) => t.created)).toEqual(['2026-10-05T10:00:00Z']);
  });

  it('counts each participant once per task, assignees and creators', () => {
    expect(s.participants).toEqual([
      { name: 'ann', open: 1, done: 1, assigned: 2, created: 1 },
      { name: 'bob', open: 1, done: 1, assigned: 0, created: 2 },
    ]);
  });

  it('has no time comparison without both dates, and no late without open work', () => {
    expect(milestoneStats({ id: 'm1', due: '2026-10-01' }, [], { today: '2026-10-16' })).toMatchObject({ timePercent: null, daysLeft: -15, late: false, percent: 0 });
  });
});

describe('dueLabel', () => {
  it('says how far the due date is', () => {
    expect(dueLabel(0)).toBe('due today');
    expect(dueLabel(1)).toBe('1 day left');
    expect(dueLabel(-3)).toBe('3 days late');
    expect(dueLabel(null)).toBe('');
  });
});

describe('sortMilestones', () => {
  it('puts open milestones first, soonest due first, undated last, closed at the end', () => {
    const ms = [
      { id: 'closed', closed: true, due: '2026-01-01' },
      { id: 'undated' },
      { id: 'late', due: '2026-12-01' },
      { id: 'soon', due: '2026-11-01' },
    ];
    expect(sortMilestones(ms).map((m) => m.id)).toEqual(['soon', 'late', 'undated', 'closed']);
  });
});

describe('milestoneId', () => {
  it('slugs a title into a field-safe id', () => {
    expect(milestoneId('M1 – CI sandbox')).toBe('m1-ci-sandbox');
    expect(milestoneId('Réinitialisation')).toBe('reinitialisation');
    expect(milestoneId('  !!! ')).toBe('milestone');
  });

  it('never reuses a taken id', () => {
    expect(milestoneId('Reset', ['reset', 'reset-2'])).toBe('reset-3');
  });
});

describe('milestoneLabel and formatCreated', () => {
  it('shows the title, or the raw id of an unknown milestone', () => {
    const ms = [{ id: 'm1', title: 'Reset' }];
    expect(milestoneLabel(ms, 'm1')).toBe('Reset');
    expect(milestoneLabel(ms, 'gone')).toBe('gone');
    expect(milestoneLabel(ms, '')).toBe('');
  });

  it('keeps an unparsable created value as written', () => {
    expect(formatCreated('yesterday')).toBe('yesterday');
    expect(formatCreated('2026-10-23T12:05:12Z')).toMatch(/2026/);
  });
});

describe('milestone filter', () => {
  it('matches one milestone, or tasks without one', () => {
    expect(matchesTaskFilters({ milestone: 'm1' }, { milestone: 'm1' })).toBe(true);
    expect(matchesTaskFilters({ milestone: 'm2' }, { milestone: 'm1' })).toBe(false);
    expect(matchesTaskFilters({}, { milestone: '@none' })).toBe(true);
    expect(matchesTaskFilters({ milestone: 'm1' }, { milestone: '@none' })).toBe(false);
    expect(matchesTaskFilters({ milestone: 'm1' }, {})).toBe(true);
  });
});
