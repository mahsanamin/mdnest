import mermaid from 'mermaid';

// Shared mermaid configuration — imported by both Preview.jsx and MermaidBlock.jsx
// to ensure consistent theme regardless of which component loads first.
mermaid.initialize({
  startOnLoad: false,
  theme: 'base',
  themeVariables: {
    darkMode: true,
    background: '#1e1e2e',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',

    // Primary nodes — dark blue fill, light text
    primaryColor: '#313244',
    primaryTextColor: '#cdd6f4',
    primaryBorderColor: '#74c7ec',

    // Secondary nodes — muted green fill, light text
    secondaryColor: '#2a4a3a',
    secondaryTextColor: '#cdd6f4',
    secondaryBorderColor: '#94e2d5',

    // Tertiary nodes — muted purple fill, light text
    tertiaryColor: '#3a2a4a',
    tertiaryTextColor: '#cdd6f4',
    tertiaryBorderColor: '#cba6f7',

    // Global defaults
    lineColor: '#7f849c',
    textColor: '#cdd6f4',
    mainBkg: '#313244',
    nodeBorder: '#74c7ec',
    nodeTextColor: '#cdd6f4',

    // Clusters (subgraphs)
    clusterBkg: '#181825',
    clusterBorder: '#585b70',

    // Labels & misc
    titleColor: '#cdd6f4',
    edgeLabelBackground: '#313244',
    noteBkgColor: '#313244',
    noteTextColor: '#cdd6f4',
    noteBorderColor: '#585b70',

    // Sequence diagrams
    actorTextColor: '#cdd6f4',
    actorBkg: '#313244',
    actorBorder: '#74c7ec',
    signalColor: '#cdd6f4',
    loopTextColor: '#cdd6f4',
    labelBoxBkgColor: '#313244',
    labelBoxBorderColor: '#585b70',
    labelTextColor: '#cdd6f4',
  },
});

// Post-process mermaid SVG: force readable text colors.
// Mermaid calculates text color from theme, but user-defined fills
// (e.g. style A fill:#d4edda) override theme text, producing invisible text.
// This walks all text elements, detects parent fill brightness, and forces
// dark text on light fills or light text on dark fills.
export function fixMermaidTextColors(svgEl) {
  const lightText = '#cdd6f4';
  const darkText = '#1e1e2e';

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
