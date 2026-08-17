import { describe, it, expect } from 'vitest';
import { isExcalidrawDoc, parseExcalidraw, serializeExcalidraw, noteRelativePath } from '../excalidraw.js';

describe('isExcalidrawDoc', () => {
  it('matches .excalidraw.md and .excalidraw, case-insensitively', () => {
    expect(isExcalidrawDoc('drawings/Sketch.excalidraw.md')).toBe(true);
    expect(isExcalidrawDoc('a/b.EXCALIDRAW')).toBe(true);
    expect(isExcalidrawDoc('notes/plan.md')).toBe(false);
    expect(isExcalidrawDoc('')).toBe(false);
    expect(isExcalidrawDoc(null)).toBe(false);
  });
});

describe('excalidraw round-trip', () => {
  const scene = {
    elements: [
      { id: 'a1', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
      { id: 't1', type: 'text', text: 'Hello, world', x: 5, y: 5 },
      { id: 't2', type: 'text', text: 'gone', isDeleted: true },
    ],
    appState: { viewBackgroundColor: '#fff', gridSize: 20, selectedElementIds: { a1: true } },
    files: {},
  };

  it('serializes to Obsidian-compatible markdown with searchable text', () => {
    const md = serializeExcalidraw(scene);
    expect(md).toContain('excalidraw-plugin: parsed');
    expect(md).toContain('## Text Elements');
    expect(md).toContain('Hello, world ^t1'); // live text mirrored + searchable
    expect(md).not.toContain('gone'); // deleted elements are stripped entirely
    expect(md).toContain('## Drawing');
    expect(md).toContain('```json');
  });

  it('parses back only the live elements (deleted are stripped)', () => {
    const md = serializeExcalidraw(scene);
    const back = parseExcalidraw(md);
    expect(back.elements).toHaveLength(2);
    expect(back.elements.map((e) => e.id)).toEqual(['a1', 't1']);
    expect(back.elements[1].text).toBe('Hello, world');
    // transient appState (selection) is not persisted
    expect(back.appState.selectedElementIds).toBeUndefined();
    expect(back.appState.viewBackgroundColor).toBe('#fff');
    expect(back.appState.gridSize).toBe(20);
  });

  it('round-trips referenced image files and prunes orphaned ones', () => {
    const withImages = {
      elements: [
        { id: 'img1', type: 'image', fileId: 'f-used' },
        { id: 'img2', type: 'image', fileId: 'f-orphan', isDeleted: true },
      ],
      appState: {},
      files: {
        'f-used': { mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA' },
        'f-orphan': { mimeType: 'image/png', dataURL: 'data:image/png;base64,BBBB' },
      },
    };
    const back = parseExcalidraw(serializeExcalidraw(withImages));
    expect(back.elements).toHaveLength(1); // deleted image dropped
    expect(back.files['f-used']).toBeTruthy(); // referenced image kept
    expect(back.files['f-orphan']).toBeUndefined(); // orphaned image pruned
  });

  it('returns null for an empty/blank note (a fresh drawing)', () => {
    expect(parseExcalidraw('')).toBeNull();
    expect(parseExcalidraw('# just notes\n')).toBeNull();
  });

  it('parses a bare .excalidraw JSON file', () => {
    const raw = JSON.stringify({ type: 'excalidraw', elements: [{ id: 'x', type: 'ellipse' }], appState: {} });
    const back = parseExcalidraw(raw);
    expect(back.elements).toHaveLength(1);
    expect(back.elements[0].type).toBe('ellipse');
  });
});

describe('noteRelativePath (embed target resolution)', () => {
  it('resolves a sibling drawing against the note directory', () => {
    expect(noteRelativePath('folder/note.md', 'sketch.excalidraw.md')).toBe('folder/sketch.excalidraw.md');
  });
  it('resolves parent (..) and current (.) segments', () => {
    expect(noteRelativePath('a/b/note.md', '../draw.excalidraw.md')).toBe('a/draw.excalidraw.md');
    expect(noteRelativePath('a/b/note.md', './draw.excalidraw.md')).toBe('a/b/draw.excalidraw.md');
  });
  it('treats a leading slash as namespace-root', () => {
    expect(noteRelativePath('a/b/note.md', '/top.excalidraw.md')).toBe('top.excalidraw.md');
  });
  it('handles a note at the namespace root', () => {
    expect(noteRelativePath('note.md', 'd.excalidraw.md')).toBe('d.excalidraw.md');
  });
});
