import { describe, it, expect } from 'vitest';
import {
  CLIPBOARD_MAX_BYTES, utf8Bytes, stripNoteMarker, buildClipboardPayload, parseClipboardPayload,
  safeFileName, suggestCopyName, localLinks, joinPath, isInvalidDestination, describeRefusal,
  filenameFromDisposition,
} from '../transfer.js';

describe('clipboard payload', () => {
  it('round-trips a note without its marker', () => {
    const r = buildClipboardPayload('plan.md', '# Plan\n\nbody\n\n<!-- mdnest:aaaaaaaa-1111-4111-8111-111111111111 -->\n');
    expect(r.ok).toBe(true);
    expect(r.text).not.toContain('mdnest:aaaa');
    const p = parseClipboardPayload(r.text);
    expect(p).toEqual({ ok: true, name: 'plan.md', content: '# Plan\n\nbody\n' });
  });

  // Case 15: a note over 1 MB is refused, on copy and on paste.
  it('refuses a note over 1 MB', () => {
    const big = 'x'.repeat(CLIPBOARD_MAX_BYTES + 10);
    const r = buildClipboardPayload('big.md', big);
    expect(r).toMatchObject({ ok: false, reason: 'too_large' });
    expect(r.bytes).toBeGreaterThan(CLIPBOARD_MAX_BYTES);
    const pasted = JSON.stringify({ mdnest: 'file/v1', name: 'big.md', content: big });
    expect(parseClipboardPayload(pasted)).toMatchObject({ ok: false, reason: 'too_large' });
  });

  // Case 16: the limit is UTF-8 bytes, not string length.
  it('measures the limit in UTF-8 bytes, not characters', () => {
    const urdu = 'ملاحظات '.repeat(Math.ceil(CLIPBOARD_MAX_BYTES / 15) / 1);
    expect(urdu.length).toBeLessThan(CLIPBOARD_MAX_BYTES);
    expect(utf8Bytes(urdu)).toBeGreaterThan(CLIPBOARD_MAX_BYTES);
    expect(buildClipboardPayload('urdu.md', urdu)).toMatchObject({ ok: false, reason: 'too_large' });

    const emoji = '😀'.repeat(300 * 1024); // 600K UTF-16 units, 1.2 MB of UTF-8
    expect(emoji.length).toBeLessThan(CLIPBOARD_MAX_BYTES);
    expect(buildClipboardPayload('emoji.md', emoji).ok).toBe(false);
    expect(parseClipboardPayload(JSON.stringify({ mdnest: 'file/v1', name: 'e.md', content: emoji })).ok).toBe(false);

    const small = '😀'.repeat(1000);
    expect(buildClipboardPayload('ok.md', small).ok).toBe(true);
  });

  it('rejects anything that is not an mdnest payload', () => {
    for (const t of ['hello', '', '{"mdnest":"file/v2","name":"x","content":"y"}', '{"name":"x.md","content":"y"}', '{broken', '{"mdnest":"file/v1","name":"x.md","content":7}']) {
      expect(parseClipboardPayload(t)).toMatchObject({ ok: false, reason: 'not_mdnest' });
    }
  });

  it('never lets a pasted name pick a folder', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('a/b/c.md')).toBe('c.md');
    expect(safeFileName('..\\win.md')).toBe('win.md');
    expect(safeFileName('.hidden.md')).toBe('hidden.md');
    expect(safeFileName('')).toBe('pasted.md');
    expect(safeFileName('..')).toBe('pasted.md');
    expect(safeFileName('x\u0000y.md')).toBe('xy.md');
    expect(parseClipboardPayload('{"mdnest":"file/v1","name":"../../x.md","content":"y"}').name).toBe('x.md');
  });

  it('strips only a real marker line', () => {
    expect(stripNoteMarker('text <!-- mdnest:abc --> inline\n')).toBe('text <!-- mdnest:abc --> inline\n');
    expect(stripNoteMarker('a\n\n<!-- mdnest:0a-1 -->\n')).toBe('a\n');
  });
});

describe('copy names, links, destinations', () => {
  it('suggests a copy name and never repeats one', () => {
    expect(suggestCopyName('plan.md')).toBe('plan (copy).md');
    expect(suggestCopyName('plan (copy).md')).toBe('plan (copy 2).md');
    expect(suggestCopyName('plan (copy 2).md')).toBe('plan (copy 3).md');
    expect(suggestCopyName('Sketch.excalidraw.md')).toBe('Sketch (copy).excalidraw.md');
    expect(suggestCopyName('Makefile')).toBe('Makefile (copy)');
  });

  it('finds local links that will not travel to another server', () => {
    const c = '![a](img.png) [n](../other.md) [w](https://x.y/z) ![[pic.jpg]] ![d](data:image/png;base64,AA) [h](#top) ![a](img.png)';
    expect(localLinks(c)).toEqual(['img.png', '../other.md', 'pic.jpg']);
  });

  it('builds destination paths and hides self-nesting', () => {
    expect(joinPath('/', 'x.md')).toBe('x.md');
    expect(joinPath('', 'x.md')).toBe('x.md');
    expect(joinPath('/a/b', 'x.md')).toBe('a/b/x.md');
    const base = { sourceNs: 'p', sourcePath: 'F' };
    expect(isInvalidDestination({ ...base, destNs: 'p', destFolder: '/F' })).toBe(true);
    expect(isInvalidDestination({ ...base, destNs: 'p', destFolder: '/F/sub' })).toBe(true);
    expect(isInvalidDestination({ ...base, destNs: 'p', destFolder: '/Fx' })).toBe(false);
    expect(isInvalidDestination({ ...base, destNs: 'q', destFolder: '/F' })).toBe(false);
  });
});

describe('the server answers in plain words', () => {
  it('names the collision, the counts, and busy', () => {
    expect(describeRefusal(200, {})).toBe('');
    expect(describeRefusal(409, { error: 'exists', path: 'Project/x.md' })).toContain('"Project/x.md" already exists');
    const t = describeRefusal(413, { files: 612, bytes: 146800640, maxFiles: 500, maxBytes: 104857600 });
    expect(t).toContain('612 files');
    expect(t).toContain('140 MB');
    expect(t).toContain('500 files and 100 MB');
    expect(t).toContain('subfolder');
    expect(describeRefusal(429, { error: 'busy' })).toMatch(/Another download is running/);
    expect(describeRefusal(400, { error: 'symlink', path: 'F/link' })).toContain('F/link');
  });

  it('reads the download name, preferring the UTF-8 form', () => {
    expect(filenameFromDisposition(`attachment; filename="_______.md"; filename*=UTF-8''%D9%85%D9%84%D8%A7%D8%AD%D8%B8%D8%A7%D8%AA.md`, 'x')).toBe('ملاحظات.md');
    expect(filenameFromDisposition('attachment; filename="Proj.zip"', 'x')).toBe('Proj.zip');
    expect(filenameFromDisposition(null, 'fallback.zip')).toBe('fallback.zip');
  });
});
