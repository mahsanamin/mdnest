// Retrying wrapper around React.lazy for code-split chunks.
//
// Two layers of caching make a failed dynamic import permanent, so a plain
// re-render can never recover from one:
//   1. The browser's module map remembers a failed fetch for a specifier, so
//      re-importing the same URL can return the same rejection without ever
//      going back to the network.
//   2. React.lazy caches the rejected promise, so every later render of that
//      component re-throws the original error.
//
// The failure that motivated this was not a flaky network: a reverse proxy
// (nginx-proxy-manager's stock asset cache is `proxy_cache_valid any 30m`,
// which caches *any* status code) stored a 504 for one chunk URL while the
// upstream was briefly down. Asset filenames are content-hashed and therefore
// immutable, so that entry could never be displaced — the drawing editor was
// unreachable for the full TTL even though the server was healthy again.
//
// The proxy's cache key is the request URI, so the last attempt appends a
// query string: a different URI misses the poisoned entry and fetches the
// real file. Earlier attempts reuse the plain specifier, which is what Vite's
// preload/module graph expects and what recovers a genuine network blip.
const RETRY_PARAM = 'mdnest_retry';

// chunkUrlFromError digs the chunk URL out of the browser's error message.
// Chrome/Edge say "Failed to fetch dynamically imported module: <url>". Other
// engines word it differently and carry no URL — those fall back to retrying
// the plain specifier, which still fixes a transient failure.
export function chunkUrlFromError(err) {
  const msg = err && err.message ? String(err.message) : '';
  const m = msg.match(/https?:\/\/[^\s'")]+/);
  return m ? m[0] : null;
}

// withRetryParam appends the cache-busting query used on the final attempt.
export function withRetryParam(url, token) {
  return `${url}${url.includes('?') ? '&' : '?'}${RETRY_PARAM}=${token}`;
}

// loadWithRetry resolves the module, retrying on failure. Exported (and pure
// apart from the injected importer) so the retry policy is unit-testable
// without a bundler.
export async function loadWithRetry(factory, opts = {}) {
  const {
    retries = 2,
    delayMs = 350,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    importUrl = (url) => import(/* @vite-ignore */ url),
    token = () => String(Date.now()),
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Only the final attempt cache-busts: a mid-sequence retry of the plain
      // URL is what recovers a blip, and we would rather not create a second
      // module instance unless the plain URL is genuinely unusable.
      const isLast = attempt === retries;
      const url = isLast && attempt > 0 ? chunkUrlFromError(lastErr) : null;
      return url ? await importUrl(withRetryParam(url, token())) : await factory();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}
