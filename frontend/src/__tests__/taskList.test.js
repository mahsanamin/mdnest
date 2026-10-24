import { describe, it, expect } from 'vitest';
import { isTaskListPath, isTaskOnlyDoc, taskListName } from '../taskList.js';

describe('isTaskListPath', () => {
  it('matches the .tasks.md suffix only', () => {
    expect(isTaskListPath('sprint/12.tasks.md')).toBe(true);
    expect(isTaskListPath('Sprint.TASKS.md')).toBe(true);
    expect(isTaskListPath('tasks.md')).toBe(false);
    expect(isTaskListPath('notes.md')).toBe(false);
    expect(isTaskListPath(null)).toBe(false);
  });
});

describe('isTaskOnlyDoc', () => {
  it('accepts tasks with their fields, steps and notes, headings and blank lines', () => {
    const doc = [
      '# Sprint 12',
      '',
      '- [ ] Ship the release notes',
      '  - due: 2026-11-02',
      '  - [x] draft',
      '  - [ ] review',
      '',
      '  Some notes about it.',
      '* [x] Fix the login redirect',
      '<!-- moved from the backlog -->',
      '## Later',
      '+ [ ] Record the demo',
    ].join('\n');
    expect(isTaskOnlyDoc(doc)).toBe(true);
  });

  it('skips a leading frontmatter block', () => {
    expect(isTaskOnlyDoc('---\nowner: ops\n---\n- [ ] one\n')).toBe(true);
  });

  it('rejects notes mixing tasks with other markdown', () => {
    expect(isTaskOnlyDoc('Intro paragraph.\n\n- [ ] one\n')).toBe(false);
    expect(isTaskOnlyDoc('- [ ] one\n- plain bullet\n')).toBe(false);
    expect(isTaskOnlyDoc('- [ ] one\n\n```\ncode\n```\n')).toBe(false);
    expect(isTaskOnlyDoc('| a | b |\n- [ ] one\n')).toBe(false);
  });

  it('rejects indented text that belongs to no task', () => {
    expect(isTaskOnlyDoc('# Title\n  indented\n- [ ] one\n')).toBe(false);
    expect(isTaskOnlyDoc('- [ ] one\n# Done\n  stray\n')).toBe(false);
  });

  it('needs at least one task', () => {
    expect(isTaskOnlyDoc('')).toBe(false);
    expect(isTaskOnlyDoc('# Only a heading\n')).toBe(false);
    expect(isTaskOnlyDoc(null)).toBe(false);
  });

  it('ignores numbered items, which the server does not read as tasks', () => {
    expect(isTaskOnlyDoc('1. [ ] one\n')).toBe(false);
  });
});

describe('taskListName', () => {
  it('appends the suffix, replacing a plain .md', () => {
    expect(taskListName('sprint-12')).toBe('sprint-12.tasks.md');
    expect(taskListName('sprint-12.md')).toBe('sprint-12.tasks.md');
    expect(taskListName(' /sprint-12.tasks.md ')).toBe('sprint-12.tasks.md');
  });
});
