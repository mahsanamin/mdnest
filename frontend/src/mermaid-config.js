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

export default mermaid;
