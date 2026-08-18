// Regression tests for chunk-load retry.
//
// The motivating incident: a reverse proxy cached a 504 for one immutable,
// content-hashed asset URL (nginx-proxy-manager ships `proxy_cache_valid any
// 30m`, which caches *any* status). Because the filename never changes, the
// plain URL stayed poisoned for the whole TTL — so the final attempt has to
// change the URL, not just repeat the request.

import { describe, it, expect } from 'vitest';
import { loadWithRetry, chunkUrlFromError, withRetryParam } from '../lazyWithRetry.js';

const noSleep = () => Promise.resolve();
const chunkErr = (url) =>
  new Error(`Failed to fetch dynamically imported module: ${url}`);
const URL_A = 'https://example.test/assets/ExcalidrawEditor-BeNQcv-S.js';

describe('chunkUrlFromError', () => {
  it('pulls the chunk URL out of the browser message', () => {
    expect(chunkUrlFromError(chunkErr(URL_A))).toBe(URL_A);
  });
  it('returns null when the engine gives no URL', () => {
    expect(chunkUrlFromError(new Error('Importing a module script failed.'))).toBeNull();
    expect(chunkUrlFromError(undefined)).toBeNull();
  });
});

describe('withRetryParam', () => {
  it('appends the cache-buster', () => {
    expect(withRetryParam('https://x/a.js', '9')).toBe('https://x/a.js?mdnest_retry=9');
  });
  it('respects an existing query string', () => {
    expect(withRetryParam('https://x/a.js?v=1', '9')).toBe('https://x/a.js?v=1&mdnest_retry=9');
  });
});

describe('loadWithRetry', () => {
  it('returns the module without retrying when the import succeeds', async () => {
    let calls = 0;
    const mod = await loadWithRetry(async () => { calls++; return { default: 'M' }; }, { sleep: noSleep });
    expect(mod).toEqual({ default: 'M' });
    expect(calls).toBe(1);
  });

  it('recovers from a transient failure by repeating the plain import', async () => {
    let calls = 0;
    const mod = await loadWithRetry(
      async () => { calls++; if (calls === 1) throw chunkErr(URL_A); return { default: 'M' }; },
      { sleep: noSleep },
    );
    expect(mod).toEqual({ default: 'M' });
    expect(calls).toBe(2);
  });

  it('cache-busts the URL on the final attempt when the plain URL keeps failing', async () => {
    // This is the poisoned-proxy-cache case: the plain URL never recovers, so
    // the last attempt must request a *different* URI to miss the bad entry.
    const requested = [];
    const mod = await loadWithRetry(
      async () => { throw chunkErr(URL_A); },
      {
        sleep: noSleep,
        token: () => '123',
        importUrl: async (url) => { requested.push(url); return { default: 'M' }; },
      },
    );
    expect(mod).toEqual({ default: 'M' });
    expect(requested).toEqual([`${URL_A}?mdnest_retry=123`]);
  });

  it('gives up and rethrows the last error so the boundary can render', async () => {
    const boom = chunkErr(URL_A);
    await expect(
      loadWithRetry(async () => { throw boom; }, {
        sleep: noSleep,
        importUrl: async () => { throw boom; },
      }),
    ).rejects.toBe(boom);
  });

  it('falls back to the plain specifier when the error carries no URL', async () => {
    // Firefox/Safari word the error differently and give no URL — retrying the
    // specifier is still the right move, and must not crash trying to parse.
    let calls = 0;
    const mod = await loadWithRetry(
      async () => { calls++; if (calls < 3) throw new Error('Importing a module script failed.'); return { default: 'M' }; },
      { sleep: noSleep },
    );
    expect(mod).toEqual({ default: 'M' });
    expect(calls).toBe(3);
  });
});
