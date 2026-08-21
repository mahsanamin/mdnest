import mermaid from 'mermaid';
import { currentTheme } from './theme.js';

// Shared mermaid configuration — imported by both Preview.jsx and MermaidBlock.jsx
// to ensure consistent theme regardless of which component loads first.
//
// mermaid.initialize() is global and applies at RENDER time, not at import
// time, so switching theme means calling it again and re-rendering every
// diagram already on screen. Diagrams are imperative SVG written into the DOM
// by the two components above; nothing re-runs them on a React state change,
// which is why applyMermaidTheme exists and why those components subscribe to
// onThemeChange rather than reading a prop.

const PALETTES = {
  dark: {
    darkMode: true,
    background: '#1e1e2e',
    node: '#313244',
    nodeText: '#cdd6f4',
    nodeBorder: '#74c7ec',
    secondary: '#2a4a3a',
    secondaryBorder: '#94e2d5',
    tertiary: '#3a2a4a',
    tertiaryBorder: '#cba6f7',
    line: '#7f849c',
    cluster: '#181825',
    clusterBorder: '#585b70',
  },
  light: {
    darkMode: false,
    background: '#eff1f5',
    node: '#dce0e8',
    nodeText: '#4c4f69',
    nodeBorder: '#0e7490',
    secondary: '#d7ead9',
    secondaryBorder: '#179299',
    tertiary: '#e4dcf4',
    tertiaryBorder: '#8839ef',
    line: '#7c7f93',
    cluster: '#e6e9ef',
    clusterBorder: '#acb0be',
  },
};

function configFor(theme) {
  const p = PALETTES[theme] || PALETTES.dark;
  return {
    startOnLoad: false,
    theme: 'base',
    themeVariables: {
      darkMode: p.darkMode,
      background: p.background,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',

      // Primary nodes
      primaryColor: p.node,
      primaryTextColor: p.nodeText,
      primaryBorderColor: p.nodeBorder,

      // Secondary nodes — muted green fill
      secondaryColor: p.secondary,
      secondaryTextColor: p.nodeText,
      secondaryBorderColor: p.secondaryBorder,

      // Tertiary nodes — muted purple fill
      tertiaryColor: p.tertiary,
      tertiaryTextColor: p.nodeText,
      tertiaryBorderColor: p.tertiaryBorder,

      // Global defaults
      lineColor: p.line,
      textColor: p.nodeText,
      mainBkg: p.node,
      nodeBorder: p.nodeBorder,
      nodeTextColor: p.nodeText,

      // Clusters (subgraphs)
      clusterBkg: p.cluster,
      clusterBorder: p.clusterBorder,

      // Labels & misc
      titleColor: p.nodeText,
      edgeLabelBackground: p.node,
      noteBkgColor: p.node,
      noteTextColor: p.nodeText,
      noteBorderColor: p.clusterBorder,

      // Sequence diagrams
      actorTextColor: p.nodeText,
      actorBkg: p.node,
      actorBorder: p.nodeBorder,
      signalColor: p.nodeText,
      loopTextColor: p.nodeText,
      labelBoxBkgColor: p.node,
      labelBoxBorderColor: p.clusterBorder,
      labelTextColor: p.nodeText,
    },
  };
}

let activeTheme = currentTheme();
mermaid.initialize(configFor(activeTheme));

/**
 * Re-initialise mermaid for a theme. Returns true when the theme actually
 * changed, so callers can skip a re-render they do not need.
 */
export function applyMermaidTheme(theme) {
  const next = PALETTES[theme] ? theme : 'dark';
  if (next === activeTheme) return false;
  activeTheme = next;
  mermaid.initialize(configFor(next));
  return true;
}

/** The theme mermaid is currently configured for. */
export function mermaidTheme() {
  return activeTheme;
}

// Post-process mermaid SVG: force readable text colors.
// Mermaid calculates text color from theme, but user-defined fills
// (e.g. style A fill:#d4edda) override theme text, producing invisible text.
// This walks all text elements, detects parent fill brightness, and forces
// dark text on light fills or light text on dark fills.
// Pick the fill that actually PAINTS a node, from its shapes in document
// order. Exported for tests.
//
// The zero-area skip is the whole point. Mermaid nests an empty `<rect></rect>`
// spacer inside the `g.label` group of every flowchart node. It has no width or
// height, so it paints nothing — but it still inherits mermaid's themed
// `mainBkg`, and that inherited colour is what the old walk found first. In the
// dark palette mainBkg is #313244, so every label on an author's pale
// `classDef fill:` was told its background was dark and got light ink: pale
// fill, near-invisible text. Light mode was only ever correct by luck, because
// its mainBkg happens to be bright too.
export function chooseShapeFill(shapes) {
  for (const s of shapes) {
    if (s.area === 0) continue;
    const f = s.fill;
    if (!f || f === 'none' || f === 'transparent') continue;
    return f;
  }
  return null;
}

// Perceived brightness of an [r, g, b, a] colour, composited over `ground`
// when it is not opaque. Mermaid's edge-label chip is a half-transparent
// background-color, and judging it at face value reads it as lighter (or
// darker) than what the eye actually sees over the diagram.
// Exported for tests.
export function brightnessOver(rgba, ground) {
  if (!rgba) return -1;
  const a = rgba.length > 3 && rgba[3] != null ? rgba[3] : 1;
  if (a === 0) return -1;
  const [r, g, b] = [0, 1, 2].map((i) => (a >= 1 ? rgba[i] : rgba[i] * a + ground[i] * (1 - a)));
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// The ink for a label sitting on a fill of the given brightness. The two
// extremes track the theme, so the "dark ink" chosen for a pale user fill is
// the theme's own ink rather than a near-black borrowed from the dark palette.
//
// A negative brightness means the fill could not be resolved. Falling through
// to the light ink there is wrong in light mode — white on a pale canvas — so
// an unknown background gets the theme's ordinary ink instead.
// Exported for tests.
export function inkFor(brightness, theme) {
  const lightText = theme === 'light' ? '#ffffff' : '#cdd6f4';
  const darkText = theme === 'light' ? '#4c4f69' : '#1e1e2e';
  if (brightness < 0) return theme === 'light' ? darkText : lightText;
  return brightness > 140 ? darkText : lightText;
}

export function fixMermaidTextColors(svgEl) {
  // The two extremes to choose between. They track the theme so the "dark
  // text" picked for a pale user-supplied fill is the theme's ink rather than
  // a near-black borrowed from the dark palette.

  // The diagram's own ground, for compositing anything translucent.
  const groundHex = (PALETTES[activeTheme] || PALETTES.dark).background;
  const ground = [1, 3, 5].map((i) => parseInt(groundHex.slice(i, i + 2), 16));

  function toRGBA(color) {
    if (!color || color === 'none' || color === 'transparent') return null;
    try {
      // The canvas normalises any CSS colour to #rrggbb or rgba(...).
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = color;
      const v = ctx.fillStyle;
      if (v.startsWith('#')) {
        return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).concat(1);
      }
      const n = (v.match(/[\d.]+/g) || []).map(Number);
      return n.length >= 3 ? [n[0], n[1], n[2], n.length > 3 ? n[3] : 1] : null;
    } catch { return null; }
  }

  function getBrightness(color) {
    return brightnessOver(toRGBA(color), ground);
  }

  function getNodeFill(el) {
    let node = el.closest ? el.closest('.node, .cluster, .actor, .note, .label') : null;
    if (!node) node = el.parentElement;
    while (node && node !== svgEl) {
      const painted = chooseShapeFill(
        [...node.querySelectorAll('rect, circle, polygon, path')].map((shape) => {
          // Measure before reading the colour: a spacer shape's inherited fill
          // must never win over the container it sits inside.
          let area = null;
          try {
            const bb = shape.getBBox();
            area = bb.width * bb.height;
          } catch { area = null; } // unmeasurable — judge it on colour alone
          let fill = null;
          try { fill = window.getComputedStyle(shape).fill; } catch {}
          if (!fill || fill === 'none') fill = shape.getAttribute('fill');
          return { area, fill };
        })
      );
      if (painted) return painted;
      const bg = node.getAttribute('fill') || node.style?.fill || node.style?.backgroundColor;
      if (bg && bg !== 'none' && bg !== 'transparent') return bg;
      node = node.parentElement;
    }
    return null;
  }

  // SVG text/tspan use 'fill'
  svgEl.querySelectorAll('text, tspan').forEach((t) => {
    const fill = getNodeFill(t);
    const b = getBrightness(fill);
    const color = inkFor(b, activeTheme);
    t.setAttribute('fill', color);
    t.style.fill = color;
  });

  // HTML inside foreignObject uses 'color'
  // An HTML label's own background wins over any shape behind it. Mermaid
  // paints edge labels this way — there is no rect to find, so the shape walk
  // climbed past them to some unrelated node and inked them against that.
  function htmlBackground(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      let bg = null;
      try { bg = window.getComputedStyle(n).backgroundColor; } catch {}
      const c = toRGBA(bg);
      if (c && c[3] > 0) return bg;
      if (n.tagName === 'foreignObject') break;
      n = n.parentElement;
    }
    return null;
  }

  svgEl.querySelectorAll('foreignObject span, foreignObject div, foreignObject p').forEach((t) => {
    const fill = htmlBackground(t) || getNodeFill(t.closest('foreignObject') || t);
    const b = getBrightness(fill);
    const color = inkFor(b, activeTheme);
    t.style.setProperty('color', color, 'important');
  });
}

export default mermaid;
