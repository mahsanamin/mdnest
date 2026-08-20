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
export function fixMermaidTextColors(svgEl) {
  // The two extremes to choose between. They track the theme so the "dark
  // text" picked for a pale user-supplied fill is the theme's ink rather than
  // a near-black borrowed from the dark palette.
  const lightText = activeTheme === 'light' ? '#ffffff' : '#cdd6f4';
  const darkText = activeTheme === 'light' ? '#4c4f69' : '#1e1e2e';

  function getBrightness(color) {
    if (!color || color === 'none' || color === 'transparent') return -1;
    try {
      const ctx = document.createElement('canvas').getContext('2d');
      ctx.fillStyle = color;
      const hex = ctx.fillStyle;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return (r * 299 + g * 587 + b * 114) / 1000;
    } catch { return -1; }
  }

  function getNodeFill(el) {
    let node = el.closest ? el.closest('.node, .cluster, .actor, .note, .label') : null;
    if (!node) node = el.parentElement;
    while (node && node !== svgEl) {
      for (const shape of node.querySelectorAll('rect, circle, polygon, path')) {
        // Try computed style first (catches CSS-applied fills)
        try {
          const computed = window.getComputedStyle(shape);
          const fill = computed.fill;
          if (fill && fill !== 'none') return fill;
        } catch {}
        // Fallback to attribute
        const attr = shape.getAttribute('fill');
        if (attr && attr !== 'none' && attr !== 'transparent') return attr;
      }
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
    const color = b > 140 ? darkText : lightText;
    t.setAttribute('fill', color);
    t.style.fill = color;
  });

  // HTML inside foreignObject uses 'color'
  svgEl.querySelectorAll('foreignObject span, foreignObject div, foreignObject p').forEach((t) => {
    const fill = getNodeFill(t.closest('foreignObject') || t);
    const b = getBrightness(fill);
    const color = b > 140 ? darkText : lightText;
    t.style.setProperty('color', color, 'important');
  });
}

export default mermaid;
