import { describe, it, expect } from 'vitest';
import { effectiveScope, inFolder, scopeTasks, milestonesInScope, workspaceGroups, sameTask } from '../taskScope';

describe('effectiveScope', () => {
  it('keeps a scope that has what it needs', () => {
    expect(effectiveScope('folder', { folder: 'projects' })).toBe('folder');
    expect(effectiveScope('note', { currentPath: 'a.md' })).toBe('note');
    expect(effectiveScope('global')).toBe('global');
  });
  it('falls back to the workspace without a folder or a note', () => {
    expect(effectiveScope('folder', { folder: '' })).toBe('workspace');
    expect(effectiveScope('folder', {})).toBe('workspace');
    expect(effectiveScope('note', { currentPath: null })).toBe('workspace');
    expect(effectiveScope('bogus')).toBe('workspace');
  });
});

describe('inFolder', () => {
  it('takes the folder and everything below it', () => {
    expect(inFolder('projects/a.md', 'projects')).toBe(true);
    expect(inFolder('projects/x/b.md', 'projects')).toBe(true);
    expect(inFolder('projects/x/b.md', '/projects/x/')).toBe(true);
  });
  it('does not take a sibling sharing the prefix', () => {
    expect(inFolder('projects-old/a.md', 'projects')).toBe(false);
    expect(inFolder('a.md', 'projects')).toBe(false);
  });
  it('the root holds everything', () => {
    expect(inFolder('a.md', '')).toBe(true);
  });
});

describe('scopeTasks', () => {
  const tasks = [{ path: 'p/a.md' }, { path: 'p/q/b.md' }, { path: 'r/c.md' }];
  it('cuts a folder scope to the folder', () => {
    expect(scopeTasks(tasks, 'folder', 'p').map((t) => t.path)).toEqual(['p/a.md', 'p/q/b.md']);
  });
  it('leaves the other scopes alone', () => {
    expect(scopeTasks(tasks, 'workspace', 'p')).toBe(tasks);
  });
});

describe('milestonesInScope', () => {
  const ms = [{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }];
  const tasks = [{ milestone: 'm2' }, { milestone: 'gone' }, {}];
  it('shows only the milestones with tasks in a folder or a note', () => {
    expect(milestonesInScope(ms, tasks, 'folder').map((m) => m.id)).toEqual(['m2']);
    expect(milestonesInScope(ms, tasks, 'note').map((m) => m.id)).toEqual(['m2']);
  });
  it('shows every milestone of the workspace, empty ones included', () => {
    expect(milestonesInScope(ms, tasks, 'workspace')).toBe(ms);
  });
});

describe('workspaceGroups', () => {
  const cols = [{ id: 'todo' }, { id: 'ship', done: true }];
  const boards = {
    'team-b': { columns: cols, milestones: [{ id: 'v1', title: 'B' }] },
    'team-a': { columns: cols, milestones: [{ id: 'v1', title: 'A' }] },
    empty: { columns: cols, milestones: [] },
  };
  const tasks = [
    { namespace: 'team-a', milestone: 'v1' },
    { namespace: 'team-b', milestone: 'v1' },
    { namespace: 'team-b' },
  ];
  it('one group per workspace with milestones, by name, with its own tasks', () => {
    const groups = workspaceGroups(boards, tasks);
    expect(groups.map((g) => g.ns)).toEqual(['team-a', 'team-b']);
    expect(groups[0].milestones[0].title).toBe('A');
    expect(groups[1].tasks).toHaveLength(2);
    expect(groups[1].doneColumns).toEqual(['ship']);
  });
  it('nothing without boards', () => {
    expect(workspaceGroups(undefined, tasks)).toEqual([]);
  });
});

describe('sameTask', () => {
  it('matches on workspace, note and first line', () => {
    expect(sameTask({ path: 'a.md', line: 3, raw: 'x' }, { path: 'a.md', line: 3, raw: 'y' })).toBe(true);
    expect(sameTask({ namespace: 'a', path: 'a.md', line: 3 }, { namespace: 'b', path: 'a.md', line: 3 })).toBe(false);
    expect(sameTask(null, { path: 'a.md', line: 3 })).toBe(false);
  });
});
