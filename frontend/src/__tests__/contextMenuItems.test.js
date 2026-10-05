import { describe, it, expect } from 'vitest';
import { contextMenuGroups } from '../contextMenuItems.js';

const labels = (groups) => groups.map((g) => g.map((i) => i.label));
const file = { type: 'file', path: 'Notes/plan.md' };
const folder = { type: 'folder', path: 'Notes' };

describe('right-click menu groups', () => {
  it('a writable note: organize, share, info, then Delete alone and last', () => {
    expect(labels(contextMenuGroups({ target: file, hasWrite: true, multi: true, chat: true }))).toEqual([
      ['Rename', 'Move to…', 'Copy to…'],
      ['Download', 'Copy for another mdnest', 'Copy path'],
      ['History', 'Authors'],
      ['Delete'],
    ]);
  });

  it('a writable folder: create first, Delete folder last', () => {
    expect(labels(contextMenuGroups({ target: folder, hasWrite: true, isAdmin: true, excalidraw: true, chat: true }))).toEqual([
      ['New note', 'New folder', 'New drawing', 'New chat', 'Paste here'],
      ['Rename', 'Move to…', 'Copy to…'],
      ['Download as zip', 'Copy path'],
      ['Manage access'],
      ['Delete folder'],
    ]);
  });

  it('Delete is the last item whenever it is offered', () => {
    for (const target of [file, folder]) {
      const items = contextMenuGroups({ target, hasWrite: true, isAdmin: true, multi: true, excalidraw: true, chat: true }).flat();
      expect(items.at(-1).danger).toBe(true);
      expect(items.filter((i) => i.danger)).toHaveLength(1);
    }
  });

  it('read-only: only what reading allows, and no Delete', () => {
    expect(labels(contextMenuGroups({ target: file, hasWrite: false }))).toEqual([
      ['Copy to…'],
      ['Download', 'Copy for another mdnest', 'Copy path'],
      ['History'],
    ]);
    expect(labels(contextMenuGroups({ target: folder, hasWrite: false }))).toEqual([
      ['Copy to…'],
      ['Download as zip', 'Copy path'],
    ]);
  });

  it('Authors only in multi mode, where its route exists', () => {
    const single = contextMenuGroups({ target: file, hasWrite: true, multi: false }).flat().map((i) => i.label);
    expect(single).not.toContain('Authors');
  });

  it('no "Make it a chat": a note is not converted from the menu any more', () => {
    const all = contextMenuGroups({ target: file, hasWrite: true, multi: true, chat: true }).flat();
    expect(all.map((i) => i.action)).not.toContain('convert-chat');
  });

  it('Copy for another mdnest only for text notes, and drawings get New drawing only when enabled', () => {
    const png = contextMenuGroups({ target: { type: 'file', path: 'a/pic.png' }, hasWrite: true }).flat().map((i) => i.label);
    expect(png).not.toContain('Copy for another mdnest');
    const noDraw = contextMenuGroups({ target: folder, hasWrite: true, excalidraw: false }).flat().map((i) => i.label);
    expect(noDraw).not.toContain('New drawing');
  });

  it('the namespace root: create and admin only', () => {
    expect(labels(contextMenuGroups({ target: null, hasWrite: true, isAdmin: true }))).toEqual([
      ['New note', 'New folder', 'Paste here'],
      ['Manage access'],
    ]);
  });

  it('every item has an icon', () => {
    const all = contextMenuGroups({ target: file, hasWrite: true, multi: true }).flat()
      .concat(contextMenuGroups({ target: folder, hasWrite: true, isAdmin: true, excalidraw: true, chat: true }).flat());
    for (const i of all) expect(i.icon, i.label).toBeTruthy();
  });
});
