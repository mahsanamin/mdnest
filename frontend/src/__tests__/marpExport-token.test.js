// @vitest-environment jsdom
//
// The exported deck inlines images as data-URIs, fetching each one with the
// user's mdnest JWT so that /api/files/... assets resolve. Deck content is
// authored by users and shared between them, so an image URL is attacker
// controlled: if the token rides along to an arbitrary host, exporting a deck
// someone else wrote hands them your session.
//
// These pin that the Authorization header goes ONLY to same-origin URLs.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api.js', () => ({ getToken: () => 'SECRET-JWT' }));

// marp-core is heavy and irrelevant here — stub the render so the test targets
// the asset-inlining path (which is where the token is attached).
vi.mock('@marp-team/marp-core', () => ({
  Marp: class {
    constructor() { this.themeSet = { add() {} }; }
    render(content) {
      // Echo the deck's image URLs into the rendered html, as marp-core would.
      const urls = [...String(content).matchAll(/!\[\]\(([^)]+)\)/g)].map((m) => m[1]);
      return {
        html: `<div class="marpit">${urls.map((u) => `<img src="${u}">`).join('')}</div>`,
        css: '',
      };
    }
  },
}));

vi.mock('../marpBespoke.js', () => ({ buildBespokeHtml: () => '<html></html>' }));

function authHeaderFor(calls, needle) {
  const call = calls.find(([u]) => String(u).includes(needle));
  return call?.[1]?.headers?.Authorization;
}

describe('marpExport asset inlining — token scoping', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    global.fetch = vi.fn(async (url, opts) => {
      calls.push([url, opts]);
      return {
        ok: true,
        blob: async () => new Blob(['x'], { type: 'image/png' }),
      };
    });
    // jsdom default origin
    global.URL.createObjectURL = () => 'blob:stub';
    global.URL.revokeObjectURL = () => {};
  });

  it('does NOT send the auth token to a cross-origin image host', async () => {
    const { exportHtml } = await import('../marpExport.js');
    await exportHtml('![](https://attacker.example/steal.png)', [], 'deck.md');

    const sent = authHeaderFor(calls, 'attacker.example');
    expect(sent, 'JWT must never be sent to a third-party host').toBeUndefined();
  });

  it('still sends the auth token to same-origin app assets', async () => {
    const { exportHtml } = await import('../marpExport.js');
    await exportHtml('![](/api/files/ns/photo.png)', [], 'deck.md');

    const sent = authHeaderFor(calls, '/api/files/');
    expect(sent).toBe('Bearer SECRET-JWT');
  });

  it('does not send the token to a protocol-relative cross-origin URL', async () => {
    const { exportHtml } = await import('../marpExport.js');
    await exportHtml('![](//attacker.example/steal.png)', [], 'deck.md');

    const sent = authHeaderFor(calls, 'attacker.example');
    expect(sent).toBeUndefined();
  });
});
