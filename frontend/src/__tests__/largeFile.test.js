import { describe, it, expect } from 'vitest';
import { LARGE_FILE_BYTES, fileSizeIn, isLargeSize, isLargeText, formatSize, largeFileQuestion } from '../largeFile.js';

const tree = [
  { name: 'a.md', type: 'file', path: 'a.md', size: 10 },
  { name: 'docs', type: 'folder', path: 'docs', children: [
    { name: 'big.log', type: 'file', path: 'docs/big.log', size: 3 * 1024 * 1024 },
    { name: 'old.md', type: 'file', path: 'docs/old.md' },
  ] },
];

describe('largeFile', () => {
  it('finds a file size anywhere in the tree', () => {
    expect(fileSizeIn(tree, 'a.md')).toBe(10);
    expect(fileSizeIn(tree, 'docs/big.log')).toBe(3 * 1024 * 1024);
  });
  it('returns null when the tree has no size or no such file', () => {
    expect(fileSizeIn(tree, 'docs/old.md')).toBeNull();
    expect(fileSizeIn(tree, 'nope.md')).toBeNull();
    expect(fileSizeIn(null, 'a.md')).toBeNull();
    // A folder with the same path is not a file.
    expect(fileSizeIn(tree, 'docs')).toBeNull();
  });
  it('calls a file large only above the limit', () => {
    expect(isLargeSize(LARGE_FILE_BYTES)).toBe(false);
    expect(isLargeSize(LARGE_FILE_BYTES + 1)).toBe(true);
    expect(isLargeSize(null)).toBe(false);
    expect(isLargeText('x'.repeat(LARGE_FILE_BYTES + 1))).toBe(true);
    expect(isLargeText('small')).toBe(false);
    expect(isLargeText(null)).toBe(false);
  });
  it('formats sizes for people', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
  it('names the file and its size in the question', () => {
    const q = largeFileQuestion('docs/big.log', 3 * 1024 * 1024);
    expect(q).toContain('big.log is large (3.0 MB)');
    expect(q).toContain('Open it anyway?');
  });
});
