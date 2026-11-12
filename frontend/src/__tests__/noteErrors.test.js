import { describe, it, expect } from 'vitest';
import { noteOpenError, workspaceLinkError } from '../noteErrors.js';

describe('noteErrors', () => {
  it('says when access is refused', () => {
    const e = new Error('Access denied'); e.name = 'PermissionError';
    expect(noteOpenError(e, 'team', 'plan.md')).toBe("You don't have access to plan.md in team.");
  });
  it('says when the note is missing or too large', () => {
    expect(noteOpenError(Object.assign(new Error('x'), { status: 404 }), 'team', 'gone.md')).toContain('gone.md was not found in team');
    expect(noteOpenError(Object.assign(new Error('x'), { status: 413 }), 'team', 'big.log')).toContain('too large to open');
  });
  it('falls back to a plain message', () => {
    expect(noteOpenError(new Error('net'), 'team', 'a.md')).toBe('Could not open a.md.');
  });
  it('names the workspace of a bad link', () => {
    expect(workspaceLinkError('secret')).toContain('"secret"');
  });
});
