// Pins the Preview image-src resolution — the bug where every image in
// Preview mode rendered broken: relative srcs resolved to /api/files/...
// but carried no ?token=, and a browser <img> GET can't set an
// Authorization header, so each request 401'd. The Live editor appended
// the token; the Preview renderer forgot to. Both directions matter:
// our own /api/files URLs must carry the token, and foreign/absolute
// URLs must never receive it.
import { describe, it, expect } from 'vitest';
import { resolveImgSrc } from '../img-src.js';

const BASE = '/api/files/personal/telemetry-apps-my-trips/';
const TOK = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';

describe('resolveImgSrc', () => {
  it('resolves a relative src against the note dir and appends the token', () => {
    expect(resolveImgSrc('screenshots/overview.png', BASE, TOK)).toBe(
      `${BASE}screenshots/overview.png?token=${encodeURIComponent(TOK)}`
    );
  });

  it('handles a bare filename (upload convention)', () => {
    expect(resolveImgSrc('photo.png', BASE, TOK)).toBe(
      `${BASE}photo.png?token=${encodeURIComponent(TOK)}`
    );
  });

  it('still resolves without a token (no dangling query)', () => {
    expect(resolveImgSrc('photo.png', BASE, null)).toBe(`${BASE}photo.png`);
    expect(resolveImgSrc('photo.png', BASE, '')).toBe(`${BASE}photo.png`);
  });

  it('URI-encodes the token', () => {
    const src = resolveImgSrc('a.png', BASE, 'a+b/c=');
    expect(src).toBe(`${BASE}a.png?token=a%2Bb%2Fc%3D`);
  });

  it('never attaches the token to absolute or foreign URLs', () => {
    // Image URLs are user-authored and notes are shared between users —
    // a token riding along to an arbitrary host hands them your session.
    for (const href of [
      'https://example.com/x.png',
      'http://example.com/x.png',
      'data:image/png;base64,AAAA',
      '/already/rooted.png',
    ]) {
      expect(resolveImgSrc(href, BASE, TOK)).toBe(href);
    }
  });

  // The prefix test this replaced called any filename starting with those
  // letters an absolute URL, so an ordinary uploaded screenshot rendered
  // broken in Preview while working in the Live editor.
  it('treats a filename that merely starts with a scheme name as relative', () => {
    for (const name of ['http-flow.png', 'https-diagram.png', 'httpd-setup.png', 'data-model.png']) {
      expect(resolveImgSrc(name, BASE, TOK)).toBe(
        `${BASE}${name}?token=${encodeURIComponent(TOK)}`
      );
    }
  });

  // Parity with the Live editor's proxyDomURL: /^(https?:|data:|blob:|\/)/i.
  // Both renderers show the same note, so the two tests must agree.
  it('matches the Live editor on blob: and uppercased schemes', () => {
    for (const href of ['blob:https://host/uuid', 'HTTPS://example.com/x.png', 'Data:image/png;base64,AAAA']) {
      expect(resolveImgSrc(href, BASE, TOK)).toBe(href);
    }
  });

  it('handles empty/null href safely', () => {
    expect(resolveImgSrc('', BASE, TOK)).toBe('');
    expect(resolveImgSrc(null, BASE, TOK)).toBe('');
    expect(resolveImgSrc(undefined, BASE, TOK)).toBe('');
  });
});
