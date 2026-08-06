// marpExport — download a Marp deck as a real, standalone Marp presentation.
//
// The deck is rendered entirely in the browser with @marp-team/marp-core (the
// same engine as the live preview) and wrapped in marp-cli's genuine "bespoke"
// player (see marpBespoke.js) — keyboard/touch navigation, fullscreen and
// presenter view. The result is the kind of deck `marp --html` produces, but
// with no server dependency: images are inlined as data-URIs so the single
// .html opens offline anywhere.
import { Marp } from '@marp-team/marp-core';
import { getToken } from './api.js';

function renderWithThemes(content, themes) {
  const marp = new Marp({ html: true, script: false });
  for (const t of themes || []) {
    try { marp.themeSet.add(t.css); } catch { /* skip malformed theme */ }
  }
  return marp.render(content); // { html, css }
}

// fetchAsDataURI fetches a same-origin/app URL (with the auth token) and returns
// a data: URI, or null on failure (the original URL is then left as-is).
async function fetchAsDataURI(url) {
  try {
    const headers = {};
    const token = getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// collectUrls finds candidate image URLs in html + css that should be inlined:
// http(s) and root-relative (/api/files/...), skipping data: and blob:.
function collectUrls(html, css) {
  const urls = new Set();
  const push = (u) => {
    if (!u) return;
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    urls.add(u);
  };
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi;
  const cssUrlRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = imgRe.exec(html))) push(m[1]);
  while ((m = cssUrlRe.exec(css))) push(m[1]);
  while ((m = cssUrlRe.exec(html))) push(m[1]);
  return [...urls];
}

// inlineAssets replaces every inlinable image URL in html+css with a data-URI so
// the exported deck is fully self-contained.
async function inlineAssets(html, css) {
  const urls = collectUrls(html, css);
  const map = new Map();
  await Promise.all(urls.map(async (u) => {
    const data = await fetchAsDataURI(u);
    if (data) map.set(u, data);
  }));
  const replaceAll = (s) => {
    for (const [u, data] of map) s = s.split(u).join(data);
    return s;
  };
  return { html: replaceAll(html), css: replaceAll(css) };
}

function baseName(path) {
  const b = String(path || 'deck').split('/').pop() || 'deck';
  return b.replace(/\.md$/i, '') || 'deck';
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// exportHtml downloads a real, standalone Marp presentation for the given deck.
export async function exportHtml(content, themes, title) {
  const { html, css } = renderWithThemes(content, themes);
  const inlined = await inlineAssets(html, css);
  // Strip the outer .marpit wrapper — the bespoke container re-homes the slides.
  const slides = inlined.html
    .replace(/^<div class="marpit">/, '')
    .replace(/<\/div>\s*$/, '');
  // Lazy-load the vendored bespoke assets so they never weigh on the app bundle.
  const { buildBespokeHtml } = await import('./marpBespoke.js');
  const doc = buildBespokeHtml(slides, inlined.css, baseName(title));
  downloadBlob(`${baseName(title)}.html`, new Blob([doc], { type: 'text/html;charset=utf-8' }));
}
