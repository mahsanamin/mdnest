import { describe, it, expect } from 'vitest';
import { chooseShapeFill, inkFor } from '../mermaid-config.js';

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
