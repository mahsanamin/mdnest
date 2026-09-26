import { describe, it, expect } from 'vitest';
import { laneAt, edgeScrollStep } from '../boardLanes';

// Three columns laid out like the board: a normal one, a short one, and the
// collapsed Done strip (narrower than a card).
const rects = new Map([
  ['todo', { left: 0, right: 280, top: 100, bottom: 700 }],
  ['doing', { left: 292, right: 572, top: 100, bottom: 180 }],
  ['done', { left: 584, right: 620, top: 100, bottom: 200 }],
]);

describe('laneAt', () => {
  it('picks the column under the pointer', () => {
    expect(laneAt({ x: 140, y: 300 }, rects)).toBe('todo');
  });
  it('counts the empty lane BELOW a short column as that column', () => {
    expect(laneAt({ x: 400, y: 600 }, rects)).toBe('doing');
  });
  it('hits the collapsed Done strip by pointer, not by card overlap', () => {
    expect(laneAt({ x: 600, y: 150 }, rects)).toBe('done');
  });
  it('returns null above the columns (the filter bar) and in the gaps', () => {
    expect(laneAt({ x: 140, y: 50 }, rects)).toBeNull();
    expect(laneAt({ x: 286, y: 300 }, rects)).toBeNull();
  });
  it('returns null without a pointer', () => {
    expect(laneAt(null, rects)).toBeNull();
  });
});

describe('edgeScrollStep', () => {
  const board = { left: 260, right: 1280 };
  it('does not scroll anywhere in the middle of the board', () => {
    // 558 is the right edge of the To Do column: dnd-kit scrolled from here.
    expect(edgeScrollStep(558, board)).toBe(0);
    expect(edgeScrollStep(1150, board)).toBe(0);
  });
  it('scrolls right near the right edge, faster closer in', () => {
    expect(edgeScrollStep(1250, board)).toBeGreaterThan(0);
    expect(edgeScrollStep(1278, board)).toBeGreaterThan(edgeScrollStep(1250, board));
  });
  it('scrolls left near the left edge', () => {
    expect(edgeScrollStep(270, board)).toBeLessThan(0);
  });
  it('is inert without a pointer or a board', () => {
    expect(edgeScrollStep(null, board)).toBe(0);
    expect(edgeScrollStep(1270, null)).toBe(0);
  });
});
