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
export function sanitizeSvg(dirty) {
  if (!dirty) return '';
  return DOMPurify.sanitize(dirty, {
    USE_PROFILES: { svg: true, svgFilters: true },
  });
}
