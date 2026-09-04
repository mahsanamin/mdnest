// resolveImgSrc — turn a markdown image href into the <img src> the Preview
// renders. A relative path resolves against the note's directory under
// /api/files/ and carries the session JWT as ?token=, because a browser
// <img> GET cannot set an Authorization header (the auth middleware accepts
// the query-param fallback for exactly this case — same mechanism the Live
// editor's proxyDomURL uses). Absolute http(s)/data:/rooted hrefs pass
// through untouched: the token must never ride along to a foreign host
// (same scoping rule as the Marp export asset inliner).
//
// Pure module (no React, no api.js import) so it is unit-testable standalone;
// Preview.jsx supplies the token from api.js getToken().
export function resolveImgSrc(href, baseDir, token) {
  let src = href || '';
  if (src && !src.startsWith('http') && !src.startsWith('data:') && !src.startsWith('/')) {
    src = baseDir + src;
    if (token) src += `?token=${encodeURIComponent(token)}`;
  }
  return src;
}
