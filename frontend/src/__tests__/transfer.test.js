import { describe, it, expect } from 'vitest';
import {
  CLIPBOARD_MAX_BYTES, utf8Bytes, stripNoteMarker, buildClipboardPayload, parseClipboardPayload, parsePastedNote, nameFromContent,
  safeFileName, suggestCopyName, localLinks, joinPath, isInvalidDestination, describeRefusal,
  filenameFromDisposition, newFolderError, transferSummary, isLargeTransfer, filterFolders,
} from '../transfer.js';

describe('paste here', () => {
  it('plain text becomes a note named after its first heading', () => {
    expect(parsePastedNote('intro\n\n## Release plan: Q4 ##\n\nbody\n')).toEqual({ ok: true, name: 'Release plan Q4.md', content: 'intro\n\n## Release plan: Q4 ##\n\nbody\n' });
    expect(nameFromContent('no heading here')).toBe('pasted.md');
    expect(nameFromContent('# ../../etc/passwd')).toBe('etc passwd.md');
  });
  it('the JSON older versions copied still pastes with its file name', () => {
    const old = buildClipboardPayload('plan.md', '# Something else\n');
    expect(parsePastedNote(old.text)).toMatchObject({ ok: true, name: 'plan.md', content: '# Something else\n' });
  });
  it('an empty paste or one over the limit is refused', () => {
    expect(parsePastedNote('  \n')).toEqual({ ok: false, reason: 'empty' });
    expect(parsePastedNote('x'.repeat(CLIPBOARD_MAX_BYTES + 1))).toMatchObject({ ok: false, reason: 'too_large' });
  });
});

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
    expect(describeRefusal(413, { files: 501, bytes: 10, maxFiles: 500, maxBytes: 100, partial: true })).toContain('at least 501 files');
    expect(describeRefusal(429, { error: 'busy' })).toMatch(/Another download is running/);
    expect(describeRefusal(400, { error: 'symlink', path: 'F/link' })).toContain('F/link');
  });

  it('reads the download name, preferring the UTF-8 form', () => {
    expect(filenameFromDisposition(`attachment; filename="_______.md"; filename*=UTF-8''%D9%85%D9%84%D8%A7%D8%AD%D8%B8%D8%A7%D8%AA.md`, 'x')).toBe('ملاحظات.md');
    expect(filenameFromDisposition('attachment; filename="Proj.zip"', 'x')).toBe('Proj.zip');
    expect(filenameFromDisposition(null, 'fallback.zip')).toBe('fallback.zip');
  });
});

describe('new folder in the picker, and the size of a transfer', () => {
  it('accepts one plain folder name and explains a refusal', () => {
    expect(newFolderError('Archive 2026')).toBe('');
    expect(newFolderError('ملاحظات')).toBe('');
    for (const bad of ['', '  ', '.', '..', 'a/b', 'a\\b', '.hidden', 'x\u0000y']) {
      expect(newFolderError(bad)).not.toBe('');
    }
    expect(newFolderError('notes', ['Notes', 'Other'])).toMatch(/already here/);
  });

  it('summarises a folder by files and size, and flags a big one', () => {
    expect(transferSummary({ folder: true, items: 37, bytes: 13 * 1024 * 1024 })).toBe('37 files (13 MB)');
    expect(transferSummary({ folder: true, items: 1, bytes: 2048 })).toBe('1 file (2 KB)');
    expect(transferSummary({ folder: false, items: 1, bytes: 10 })).toBe('');
    expect(isLargeTransfer({ folder: true, items: 3, bytes: 100 })).toBe(false);
    expect(isLargeTransfer({ folder: true, items: 60, bytes: 100 })).toBe(true);
    expect(isLargeTransfer({ folder: true, items: 2, bytes: 50 * 1024 * 1024 })).toBe(true);
  });
});

describe('Move to / Copy to folder search', () => {
  const folders = [
    { path: '/', name: '/ (root)' },
    { path: '/Archive', name: 'Archive' },
    { path: '/Archive/api-old', name: 'api-old' },
    { path: '/Projects', name: 'Projects' },
    { path: '/Projects/backend', name: 'backend' },
    { path: '/Projects/backend/api', name: 'api' },
    { path: '/Projects/frontend', name: 'frontend' },
    { path: '/Rapid', name: 'Rapid' },
  ];
  const paths = (list) => list.map((f) => f.path);

  it('an empty query leaves the list as it is', () => {
    expect(filterFolders(folders, '')).toBe(folders);
    expect(filterFolders(folders, '   ')).toBe(folders);
  });
  it('matches anywhere in the path, ignoring case', () => {
    expect(paths(filterFolders(folders, 'BACKEND'))).toEqual(['/Projects/backend', '/Projects/backend/api']);
  });
  it('every word must match, in any order', () => {
    expect(paths(filterFolders(folders, 'api proj'))).toEqual(['/Projects/backend/api']);
    expect(paths(filterFolders(folders, 'proj api'))).toEqual(['/Projects/backend/api']);
  });
  it('an exact name first, then names starting with the word, then names containing it', () => {
    expect(paths(filterFolders(folders, 'api'))).toEqual(['/Projects/backend/api', '/Archive/api-old', '/Rapid']);
  });
  it('name matches beat path-only matches', () => {
    // Projects' children match "proj" only through their path.
    expect(paths(filterFolders(folders, 'proj'))[0]).toBe('/Projects');
  });
  it('the root is never a search result, and no match is an empty list', () => {
    expect(paths(filterFolders(folders, 'root'))).toEqual([]);
    expect(filterFolders(folders, 'zzz')).toEqual([]);
  });
});
