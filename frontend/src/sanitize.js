import DOMPurify from 'dompurify';

// Centralized HTML/SVG sanitization for every place mdnest injects
// untrusted, rendered markup into the DOM (Preview innerHTML, release notes,
// mermaid SVG). Note bodies are user-controlled and shared across users, so
// marked's raw-HTML passthrough (and any `javascript:` link hrefs) must be
// scrubbed before they reach innerHTML / dangerouslySetInnerHTML.

// Keep noopener/noreferrer on links that open in a new tab even after
// sanitization, to prevent reverse tabnabbing. Applies to every sanitize
// call but only touches <a target="_blank">, so it's a no-op elsewhere.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
    node.setAttribute('rel', 'noopener noreferrer');
  }
  // Excalidraw paints an embedded image as a <symbol> in <defs> referenced by a
  // <use href="#…"> (see sanitizeSvg, which allows <use>). Keep only
  // same-document fragment references: an off-document <use href> is a classic
  // SVG XSS/exfil vector, which is exactly why DOMPurify drops <use> by default.
  if (node.nodeName && node.nodeName.toLowerCase() === 'use') {
    const href = node.getAttribute('href')
      || node.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
      || node.getAttribute('xlink:href');
    if (!href || href.charAt(0) !== '#') {
      node.parentNode && node.parentNode.removeChild(node);
    }
  }
});

// Sanitize marked() output before it is injected as HTML. DOMPurify's default
// allow-list already keeps everything the Preview post-passes rely on:
// `class`, `data-*` (e.g. data-mermaid), and <input type="checkbox"> task
// items. `target` is added explicitly so external links keep opening in a new
// tab (paired with the hook above). Dangerous URIs (javascript:, etc.) and
// event-handler attributes (onerror, onclick, …) are stripped by default.
export function sanitizeHtml(dirty) {
  return DOMPurify.sanitize(dirty, {
    ADD_ATTR: ['target'],
  });
}

// Sanitize rendered mermaid SVG before injecting it. Even with mermaid's
// default strict security level this is defense-in-depth: it strips any
// event handlers or foreignObject-smuggled scripts from the SVG.
//
// `foreignObject` MUST be allowed. DOMPurify's svg profile does not include it,
// and mermaid renders every flowchart node label inside one (htmlLabels
// defaults to true, and we don't override it) — so the plain svg profile
// silently deletes the text of every label and diagrams render as empty
// boxes. Allowing the element does not re-open the hole the profile was
// guarding: DOMPurify still walks into the subtree and strips <script>,
// <iframe>, <object>, <embed>, <form> and every on* handler. Verified against
// real mermaid output in Chromium — see tests/browser/smoke.spec.js and
// __tests__/sanitize.test.js.
//
// Do NOT "fix" this by also allowing div/span/etc. Once those tags are on the
// allow-list they fail DOMPurify's namespace check instead of being unwrapped,
// and the whole subtree — label text included — is dropped again.
export function sanitizeSvg(dirty) {
  if (!dirty) return '';
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // `use` is paired with the same-document-only guard in the
    // afterSanitizeAttributes hook above, so an embedded Excalidraw image
    // (<symbol> in <defs> painted by <use href="#…">) survives while an
    // off-document reference is dropped.
    ADD_TAGS: ['foreignObject', 'use'],
  });
}
