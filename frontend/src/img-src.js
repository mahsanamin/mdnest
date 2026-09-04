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
//
// "Already absolute" is the SAME test the Live editor's proxyDomURL uses, and
// it must stay that way — the two renderers show the same note, so a src that
// resolves in one and not the other is a broken image in exactly one mode.
// The prefix form this replaced (`startsWith('http')`) treated any filename
// beginning with those letters as an absolute URL, so `![](http-flow.png)` —
// a perfectly ordinary uploaded screenshot — never got its /api/files/ prefix
// and rendered broken in Preview while working in Live. It also missed
// `blob:` and anything uppercased. Require the scheme's colon, and match
// case-insensitively.
const ABSOLUTE_SRC = /^(https?:|data:|blob:|\/)/i;

export function resolveImgSrc(href, baseDir, token) {
  const src = href || '';
  if (!src || ABSOLUTE_SRC.test(src)) return src;
  const resolved = baseDir + src;
  return token ? `${resolved}?token=${encodeURIComponent(token)}` : resolved;
}
