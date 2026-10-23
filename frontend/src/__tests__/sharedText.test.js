import { describe, it, expect } from 'vitest';
import {
  splitFrontMatter, joinFrontMatter, mergeThreeWay,
  encodeFrame, encodeSnapshot, decodeServerFrame,
  TAG_UPDATE, TAG_AWARENESS, TAG_SNAPSHOT, TAG_STATE,
} from '../sharedText.js';
import { isSharedEligible } from '../sharedEligible.js';

describe('front matter is kept out of the shared editor', () => {
  const cases = [
    '---\ntitle: X\ntags: [a, b]\n---\n\n# Body\n',
    '---\ntitle: X\n---\nBody right after\n',
    '---\r\ntitle: X\r\n---\r\n\r\nWindows\r\n',
    '---\ntitle: only\n---',
    '---\na: 1\n...\n\ndots close\n',
    'no front matter\n---\nnot: yaml\n---\n',
    '---\nnever closed\n# body\n',
    '',
  ];
  it('split then join gives the same bytes', () => {
    for (const c of cases) {
      const { frontMatter, body } = splitFrontMatter(c);
      expect(joinFrontMatter(frontMatter, body)).toBe(c.endsWith('---') && frontMatter ? c + '\n' : c);
    }
  });
  it('splits at the closing fence and keeps the blank line with it', () => {
    expect(splitFrontMatter('---\nt: 1\n---\n\n# H\n')).toEqual({ frontMatter: '---\nt: 1\n---\n\n', body: '# H\n' });
  });
  it('a --- that is not on the first line is not front matter', () => {
    expect(splitFrontMatter('# H\n---\na: 1\n---\n').frontMatter).toBe('');
  });
  it('an unclosed fence is not front matter', () => {
    expect(splitFrontMatter('---\nhello\n').frontMatter).toBe('');
  });
  it('an edited body goes back behind the untouched front matter', () => {
    const { frontMatter } = splitFrontMatter('---\ntitle: Keep me\n---\n\nold\n');
    expect(joinFrontMatter(frontMatter, 'new body\n')).toBe('---\ntitle: Keep me\n---\n\nnew body\n');
  });
});

describe('three-way merge of an outside change', () => {
  const base = 'one\ntwo\nthree\nfour\n';
  it('takes whichever side changed', () => {
    expect(mergeThreeWay(base, base, 'one\nTWO\nthree\nfour\n')).toBe('one\nTWO\nthree\nfour\n');
    expect(mergeThreeWay(base, 'one\ntwo\nthree\nFOUR\n', base)).toBe('one\ntwo\nthree\nFOUR\n');
  });
  it('keeps both sides when they changed different lines', () => {
    const ours = 'one typed here\ntwo\nthree\nfour\n';
    const theirs = 'one\ntwo\nthree\nfour\nappended by the CLI\n';
    expect(mergeThreeWay(base, ours, theirs)).toBe('one typed here\ntwo\nthree\nfour\nappended by the CLI\n');
  });
  it('takes a change made on both sides only once', () => {
    // The leaving saver's last save landed, the new saver already had the
    // same text: merging must not double it.
    const both = 'one\ntwo plus words\nthree\nfour\n';
    expect(mergeThreeWay(base, both, both)).toBe(both);
    const ours = 'one\ntwo plus words\nthree\nfour and more\n';
    expect(mergeThreeWay(base, ours, both)).toBe(ours);
  });
  it('keeps both versions of a line changed differently on each side', () => {
    const out = mergeThreeWay(base, 'one\nmine\nthree\nfour\n', 'one\ntheirs\nthree\nfour\n');
    expect(out).toBe('one\nmine\ntheirs\nthree\nfour\n');
  });
  it('handles a missing trailing newline', () => {
    expect(mergeThreeWay('a\nb', 'a\nb\nc', 'z\na\nb')).toBe('z\na\nb\nc');
  });
});

describe('frames', () => {
  it('encodes client frames', () => {
    expect([...encodeFrame(TAG_UPDATE, new Uint8Array([7, 8]))]).toEqual([1, 7, 8]);
    expect([...encodeSnapshot(258, new Uint8Array([9]))]).toEqual([TAG_SNAPSHOT, 0, 0, 0, 0, 0, 0, 1, 2, 9]);
  });
  it('decodes server frames', () => {
    const upd = decodeServerFrame(new Uint8Array([TAG_UPDATE, 0, 0, 0, 0, 0, 0, 0, 5, 1, 2]));
    expect(upd.seq).toBe(5);
    expect([...upd.payload]).toEqual([1, 2]);
    const aw = decodeServerFrame(new Uint8Array([TAG_AWARENESS, 0, 0, 1, 2, 3]));
    expect(aw.userId).toBe(258);
    expect([...aw.payload]).toEqual([3]);
    const st = decodeServerFrame(new Uint8Array([TAG_STATE, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 1, 9, 0, 0, 0, 2, 4, 5]));
    expect(st.seq).toBe(2);
    expect(st.entries.map((e) => [...e])).toEqual([[9], [4, 5]]);
    expect(decodeServerFrame(new Uint8Array([TAG_STATE, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 9, 1]))).toBeNull();
    expect(decodeServerFrame(new Uint8Array([]))).toBeNull();
  });
});

describe('which notes are shared', () => {
  it('only plain markdown notes', () => {
    expect(isSharedEligible({ path: 'a/b.md' })).toBe(true);
    expect(isSharedEligible({ path: 'draw.excalidraw.md' })).toBe(false);
    expect(isSharedEligible({ path: 'a.md', isChat: true })).toBe(false);
    expect(isSharedEligible({ path: 'a.md', isMarp: true })).toBe(false);
    expect(isSharedEligible({ path: 'a.md', isDrawing: true })).toBe(false);
    expect(isSharedEligible({ path: 'a.txt' })).toBe(false);
    expect(isSharedEligible({ path: '' })).toBe(false);
  });
});

describe('mergeThreeWay report', () => {
  const base = 'one\ntwo\nthree\n';
  it('counts no conflict when the two sides changed different lines', () => {
    const report = {};
    expect(mergeThreeWay(base, 'ONE\ntwo\nthree\n', 'one\ntwo\nTHREE\n', report)).toBe('ONE\ntwo\nTHREE\n');
    expect(report.conflicts).toBe(0);
  });
  it('counts a conflict, and keeps both, when both changed the same line', () => {
    const report = {};
    const out = mergeThreeWay(base, 'one\ntwo mine\nthree\n', 'one\ntwo theirs\nthree\n', report);
    expect(out).toContain('two mine');
    expect(out).toContain('two theirs');
    expect(report.conflicts).toBe(1);
  });
  it('works without a report, as before', () => {
    expect(mergeThreeWay(base, base, 'x\n')).toBe('x\n');
  });
});
