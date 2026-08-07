// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractDiagramText } from '../mermaid-text.js';

// Builds a detached SVG the way mermaid's own output is shaped.
function svg(inner) {
  const host = document.createElement('div');
  host.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  return host.querySelector('svg');
}

describe('extractDiagramText', () => {
  it('reads flowchart labels out of their foreignObject islands', () => {
    // How mermaid renders a flowchart node label: the text lives in HTML
    // inside a <foreignObject>, not in an SVG <text>.
    const el = svg(`
      <g class="node"><foreignObject><div class="nodeLabel"><p>Start here</p></div></foreignObject></g>
      <g class="node"><foreignObject><div class="nodeLabel"><p>Then this</p></div></foreignObject></g>
    `);
    expect(extractDiagramText(el)).toBe('Start here\nThen this');
  });

  it('reads native SVG text, as sequence diagrams use', () => {
    const el = svg(`
      <text class="actor">Browser</text>
      <text class="messageText">GET /api/tree</text>
      <text class="actor">Backend</text>
    `);
    expect(extractDiagramText(el)).toBe('Browser\nGET /api/tree\nBackend');
  });

  it('does not count a label twice when both forms nest', () => {
    // A <text> inside a foreignObject is the same label seen twice.
    const el = svg(`<foreignObject><div class="nodeLabel"><text>Only once</text></div></foreignObject>`);
    expect(extractDiagramText(el)).toBe('Only once');
  });

  it('collapses the layout whitespace mermaid adds', () => {
    const el = svg(`<foreignObject><div class="nodeLabel">
        Wrapped   over
        lines
      </div></foreignObject>`);
    expect(extractDiagramText(el)).toBe('Wrapped over lines');
  });

  it('drops the measurement duplicate mermaid emits next to a label', () => {
    const el = svg(`
      <text>Deploy</text>
      <text>Deploy</text>
      <text>Verify</text>
    `);
    expect(extractDiagramText(el)).toBe('Deploy\nVerify');
  });

  it('keeps a label that legitimately repeats later in the diagram', () => {
    const el = svg(`<text>Retry</text><text>Check</text><text>Retry</text>`);
    expect(extractDiagramText(el)).toBe('Retry\nCheck\nRetry');
  });

  it('ignores empty and whitespace-only nodes', () => {
    const el = svg(`<text></text><text>   </text><text>Real</text>`);
    expect(extractDiagramText(el)).toBe('Real');
  });

  it('is safe on a diagram that never rendered', () => {
    expect(extractDiagramText(null)).toBe('');
    expect(extractDiagramText(undefined)).toBe('');
    expect(extractDiagramText({})).toBe('');
    expect(extractDiagramText(svg(''))).toBe('');
  });
});
