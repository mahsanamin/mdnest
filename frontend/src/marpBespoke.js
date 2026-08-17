// marpBespoke — assemble a real, standalone Marp "bespoke" presentation in the
// browser, reproducing the exact output of `marp --html` without any server.
//
// The interactive player, chrome CSS, on-screen controls and SVG polyfill are
// the genuine assets shipped by @marp-team/marp-cli (see ./vendor/marp-bespoke,
// MIT — LICENSE.txt), pinned to the version noted below. Only the per-deck
// pieces (rendered slides + theme CSS) are produced at runtime by
// @marp-team/marp-core, which mdnest already bundles for the live preview.
//
// To update: regenerate the vendored assets from a newer marp-cli
// (`marp --html`) and refresh ./vendor/marp-bespoke/*.
//
// Vendored from @marp-team/marp-cli@4.5.0.
import chromeCss from './vendor/marp-bespoke/chrome.css?raw';
import polyfillJs from './vendor/marp-bespoke/polyfill.js?raw';
import bespokeJs from './vendor/marp-bespoke/bespoke.js?raw';
import oscHtml from './vendor/marp-bespoke/osc.html?raw';

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// buildBespokeHtml returns a single self-contained HTML document string.
//   slidesHtml — the marp-core render output with the outer `.marpit` wrapper
//     stripped (i.e. the sequence of <svg data-marpit-svg> slide elements).
//   css        — the marp-core render CSS (theme + marpit base), `.marpit`-scoped.
//   title      — deck title (also used as og:title).
//
// The bespoke bundle bootstraps on `getElementById(':$p')`; that container also
// carries class `marpit` so the `.marpit`-scoped render CSS matches its slides.
export function buildBespokeHtml(slidesHtml, css, title) {
  const t = escapeHtml(title || 'deck');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,height=device-height,initial-scale=1.0">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta property="og:type" content="website">
<meta property="og:title" content="${t}">
<title>${t}</title>
<style>${chromeCss}</style>
<style>${css}</style>
</head>
<body>
${oscHtml}
<div id=":$p" class="marpit">${slidesHtml}</div>
<script>${polyfillJs}</script>
<script>${bespokeJs}</script>
</body>
</html>`;
}
