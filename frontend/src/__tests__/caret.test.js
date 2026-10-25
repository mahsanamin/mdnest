import { describe, it, expect } from 'vitest';
import { mapCaret } from '../caret.js';

describe('mapCaret', () => {
  const text = '# Note\n\nmy paragraph typed\n\nend\n';
  const at = text.indexOf('typed') + 'typed'.length;

  it('keeps the caret when text is appended after it', () => {
    expect(mapCaret(text, text + '\nline from the agent\n', at)).toBe(at);
  });
  it('shifts the caret when text is added before it', () => {
    const added = 'line from the agent\n';
    expect(mapCaret(text, added + text, at)).toBe(at + added.length);
  });
  it('moves a caret inside a replaced part to the end of the replacement', () => {
    const before = 'aaa OLD bbb';
    const after = 'aaa NEWER bbb';
    expect(mapCaret(before, after, 5)).toBe('aaa NEWER'.length);
  });
  it('handles a caret at the very end and the very start', () => {
    expect(mapCaret('abc', 'abc\nmore', 3)).toBe(3);
    expect(mapCaret('abc', 'x\nabc', 0)).toBe(0);
  });
  it('handles deletions after and before the caret', () => {
    expect(mapCaret('keep X gone', 'keep X', 6)).toBe(6);
    expect(mapCaret('gone keep X', 'keep X', 11)).toBe(6);
  });
});
