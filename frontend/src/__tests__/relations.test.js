import { describe, it, expect } from 'vitest';
import { buildRelationLookup, resolveTask, toRef, relLabel, isKnownOption } from '../relations';

const tasks = [
  { ref: 'OGFC-aaaaa', text: 'Ship it, now', checked: false },
  { ref: 'OGFC-bbbbb', text: 'Design', checked: true },
];
const entries = tasks.map((t) => ({ ref: t.ref, title: t.text, task: t }));

describe('relations lookup', () => {
  it('resolves a relation value to the live task by ref, case-insensitively', () => {
    const lk = buildRelationLookup(entries);
    expect(resolveTask(lk, 'OGFC-aaaaa')).toBe(tasks[0]);
    expect(resolveTask(lk, 'ogfc-bbbbb')).toBe(tasks[1]);
  });

  it('falls back to title for legacy values, and returns null when unknown', () => {
    const lk = buildRelationLookup(entries);
    expect(resolveTask(lk, 'Design')).toBe(tasks[1]);
    expect(resolveTask(lk, 'nope')).toBeNull();
  });

  it('maps an entered title or ref to the canonical ref, keeping commas intact', () => {
    const lk = buildRelationLookup(entries);
    expect(toRef(lk, 'Ship it, now')).toBe('OGFC-aaaaa'); // title with a comma -> ref
    expect(toRef(lk, 'ogfc-aaaaa')).toBe('OGFC-aaaaa'); // ref (any case) -> canonical
    expect(toRef(lk, 'Freeform title')).toBe('Freeform title'); // unmatched free text kept
  });

  it('labels a stored ref with its current title and flags known options', () => {
    const lk = buildRelationLookup(entries);
    expect(relLabel(lk, 'OGFC-bbbbb')).toBe('Design');
    expect(relLabel(lk, 'OGFC-zzzzz')).toBe('OGFC-zzzzz'); // unresolved -> as-is
    expect(isKnownOption(lk, 'Ship it, now')).toBe(true);
    expect(isKnownOption(lk, 'unknown')).toBe(false);
  });

  it('indexes title-only entries (tasks without a ref yet)', () => {
    const lk = buildRelationLookup([{ title: 'No ref task' }]);
    expect(isKnownOption(lk, 'No ref task')).toBe(true);
    expect(toRef(lk, 'No ref task')).toBe('No ref task'); // no ref -> kept as title
  });
});
