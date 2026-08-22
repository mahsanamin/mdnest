import { describe, it, expect } from 'vitest';
import { chooseShapeFill, inkFor, brightnessOver } from '../mermaid-config.js';

// The bug this pins: a flowchart node styled with a pale `classDef fill:` got
// light ink in dark mode, so every label was near-invisible on its own node.
// The cause was not the brightness maths — it was which shape the walk
// measured. Mermaid nests an empty `<rect></rect>` spacer inside each node's
// `g.label`, and that spacer inherits the themed `mainBkg` (#313244 in dark).
// Reading it first meant "this background is dark", on a #cfe4ff node.

describe('chooseShapeFill', () => {
  it('skips the zero-area label spacer and takes the painted container', () => {
    // Document order, exactly as mermaid emits it: the spacer is found first.
    const shapes = [
      { area: 0, fill: 'rgb(49, 50, 68)' },      // g.label spacer, inherited mainBkg
      { area: 119 * 54, fill: 'rgb(207, 228, 255)' }, // rect.label-container
    ];
    expect(chooseShapeFill(shapes)).toBe('rgb(207, 228, 255)');
  });

  it('ignores shapes that paint nothing', () => {
    expect(chooseShapeFill([
      { area: 100, fill: 'none' },
      { area: 100, fill: 'transparent' },
      { area: 100, fill: null },
      { area: 100, fill: '#2f9e44' },
    ])).toBe('#2f9e44');
  });

  it('keeps an unmeasurable shape rather than discarding it', () => {
    // getBBox() can throw; area is null then, and colour is all we have.
    expect(chooseShapeFill([{ area: null, fill: '#1971c2' }])).toBe('#1971c2');
  });

  it('returns null when nothing paints', () => {
    expect(chooseShapeFill([{ area: 0, fill: '#313244' }])).toBeNull();
    expect(chooseShapeFill([])).toBeNull();
  });
});

describe('inkFor', () => {
  // brightness of rgb(207,228,255) — the pale fill from the bug report
  const paleBlue = (207 * 299 + 228 * 587 + 255 * 114) / 1000;
  const darkSlate = (49 * 299 + 50 * 587 + 68 * 114) / 1000;

  it('puts dark ink on a pale fill in BOTH themes', () => {
    expect(inkFor(paleBlue, 'dark')).toBe('#1e1e2e');
    expect(inkFor(paleBlue, 'light')).toBe('#4c4f69');
  });

  it('puts light ink on a dark fill in both themes', () => {
    expect(inkFor(darkSlate, 'dark')).toBe('#cdd6f4');
    expect(inkFor(darkSlate, 'light')).toBe('#ffffff');
  });

  it('falls back to the theme ink when the fill is unknown', () => {
    // Not the light ink unconditionally — white on a light canvas is invisible.
    expect(inkFor(-1, 'light')).toBe('#4c4f69');
    expect(inkFor(-1, 'dark')).toBe('#cdd6f4');
  });
});

describe('brightnessOver', () => {
  const MOCHA = [30, 30, 46];   // #1e1e2e
  const LATTE = [239, 241, 245]; // #eff1f5

  it('composites a translucent chip over the diagram ground', () => {
    // Mermaid's edge-label background is rgba(49,50,68,.5). Judged at face
    // value it reads as #313244 (luminance 52); over the dark ground what the
    // eye sees is closer to 41. Either way the ink must be the light one, but
    // the number has to describe the pixel, not the declaration.
    const composited = brightnessOver([49, 50, 68, 0.5], MOCHA);
    const opaque = brightnessOver([49, 50, 68, 1], MOCHA);
    expect(composited).toBeLessThan(opaque);
    expect(composited).toBeGreaterThan(35);
    expect(inkFor(composited, 'dark')).toBe('#cdd6f4');
  });

  it('composites the same chip the other way over a light ground', () => {
    const composited = brightnessOver([220, 224, 232, 0.5], LATTE);
    expect(inkFor(composited, 'light')).toBe('#4c4f69');
  });

  it('treats a fully transparent colour as unknown, not as black', () => {
    expect(brightnessOver([0, 0, 0, 0], MOCHA)).toBe(-1);
    expect(brightnessOver(null, MOCHA)).toBe(-1);
  });

  it('leaves an opaque colour alone', () => {
    expect(brightnessOver([255, 255, 255, 1], MOCHA)).toBeCloseTo(255, 5);
    expect(brightnessOver([207, 228, 255], MOCHA)).toBeCloseTo(224.8, 1);
  });
});
