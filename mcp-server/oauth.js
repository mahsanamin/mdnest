// ---------------------------------------------------------------------------
// OAuth 2.1 bridge for the streamable-HTTP MCP server.
//
// Turns the MCP server into an OAuth 2.1 Authorization Server + Resource
// Server that delegates the actual user login to mdnest's existing corporate
// SSO (the same Entra ID flow the web frontend uses). The end result is a
// per-user mdnest JWT that the MCP server forwards to the backend on every
// request, so every action performed through MCP is attributed to the real
// signed-in user (same authorization the web UI enforces).
//
// The design is completely stateless: all transient state (the PKCE challenge,
// the client redirect URI, and the minted mdnest JWT) is carried inside
// short-lived blobs with no shared session store. The browser round-trip cookie
// is HMAC-signed (it holds no credential), while the authorization "code" is
// AES-256-GCM *encrypted* — it carries the live mdnest JWT and travels in a
// redirect URL, so it must be opaque, not merely tamper-evident. This keeps the
// deployment horizontally scalable with no shared session store.
//
// Flow:
//   1. MCP client hits /mcp with no token -> 401 + WWW-Authenticate pointing at
//      the protected-resource metadata.
//   2. Client discovers /.well-known/oauth-protected-resource and
//      /.well-known/oauth-authorization-server, then (optionally) registers via
//      /oauth/register and opens the browser to /oauth/authorize.
//   3. /oauth/authorize stores the PKCE challenge + client redirect in a signed
//      cookie and redirects the browser to the backend SSO start, asking it to
//      hand the minted JWT back to this server's /oauth/idp-callback.
//   4. The backend runs the normal Entra login and redirects the browser to
//      /oauth/idp-callback with the mdnest JWT in the URL fragment.
//   5. /oauth/idp-callback runs a tiny script that reads the fragment and POSTs
//      the token to /oauth/finish, which validates it against the backend,
//      mints an encrypted authorization code, and bounces the browser back to
//      the MCP client's redirect URI.
//   6. /oauth/token verifies the PKCE verifier and returns the mdnest JWT as the
//      access token.
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual, createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function sign(obj, secret) {
  const payload = b64url(JSON.stringify(obj));
  const sig = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verify(str, secret) {
  if (typeof str !== "string" || !str.includes(".")) return null;
  const [payload, sig] = str.split(".", 2);
  if (!payload || !sig) return null;
  const expected = b64url(createHmac("sha256", secret).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let obj;
  try {
    obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (obj.exp && Date.now() / 1000 > obj.exp) return null;
  return obj;
}

// deriveKey turns an arbitrary-length secret into a fixed 32-byte AES-256 key.
const deriveKey = (secret) => createHash("sha256").update(secret).digest();

// seal encrypts obj into an opaque, tamper-evident token (AES-256-GCM). Unlike
// sign(), which only authenticates a *readable* payload, seal keeps the payload
// confidential. It is used for the authorization code, which carries a live
// mdnest JWT and travels in a redirect URL (browser history, client logs): a
// signed-only code would let anyone who reads that URL base64-decode the token.
function seal(obj, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`;
}

// unseal reverses seal(). Returns null on any tampering, malformed input, or
// expiry (mirroring verify()'s exp check).
function unseal(str, secret) {
  if (typeof str !== "string") return null;
  const parts = str.split(".");
  if (parts.length !== 3) return null;
  let obj;
  try {
    const [iv, ct, tag] = parts.map((p) => Buffer.from(p, "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    obj = JSON.parse(pt.toString("utf8"));
  } catch {
    return null;
  }
  if (obj.exp && Date.now() / 1000 > obj.exp) return null;
  return obj;
}

function pkceMatches(verifier, challenge) {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  const computed = b64url(createHash("sha256").update(verifier).digest());
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const pair of raw.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function parseForm(body, contentType) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(body || "{}");
    } catch {
      return {};
    }
  }
  // default: application/x-www-form-urlencoded
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

const json = (res, status, obj, extraHeaders = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders });
  res.end(JSON.stringify(obj));
};

const TX_COOKIE = "mcp_oauth_tx";

// buildOAuth wires an OAuth bridge from its configuration.
//   publicUrl        absolute external base URL of this MCP server
//   mcpPath          the MCP JSON-RPC path (e.g. "/mcp")
//   secret           HMAC secret for signing cookies + codes (Buffer/string)
//   ssoAuthorizeUrl  public URL of the backend SSO start endpoint
//   validateUrl      in-cluster backend URL used to validate a minted token
//   secureCookie     set the Secure flag on the transaction cookie
export function buildOAuth({ publicUrl, mcpPath, secret, ssoAuthorizeUrl, validateUrl, secureCookie }) {
  const base = publicUrl.replace(/\/+$/, "");
  const resource = base + mcpPath;
  const key = typeof secret === "string" ? Buffer.from(secret) : secret;

  const protectedResourceMeta = {
    resource,
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
  };

  const authServerMeta = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mdnest"],
  };

  const setTxCookie = (res, value) => {
    const parts = [
      `${TX_COOKIE}=${value}`,
      "Path=/oauth",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=600",
    ];
    if (secureCookie) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  };

  const clearTxCookie = (res) => {
    const parts = [`${TX_COOKIE}=`, "Path=/oauth", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
    if (secureCookie) parts.push("Secure");
    res.setHeader("Set-Cookie", parts.join("; "));
  };

  // GET /oauth/authorize
  const handleAuthorize = (req, res, url) => {
    const q = url.searchParams;
    const responseType = q.get("response_type");
    const redirectUri = q.get("redirect_uri");
    const codeChallenge = q.get("code_challenge");
    const method = q.get("code_challenge_method");
    const state = q.get("state") || "";

    if (responseType !== "code" || !redirectUri || !codeChallenge || method !== "S256") {
      json(res, 400, { error: "invalid_request", error_description: "response_type=code, redirect_uri, code_challenge and code_challenge_method=S256 are required" });
      return;
    }
    // Only allow loopback (native MCP clients) or https redirect URIs.
    let rd;
    try {
      rd = new URL(redirectUri);
    } catch {
      json(res, 400, { error: "invalid_request", error_description: "invalid redirect_uri" });
      return;
    }
    const isLoopback = rd.hostname === "127.0.0.1" || rd.hostname === "localhost" || rd.hostname === "::1";
    if (rd.protocol !== "https:" && !isLoopback) {
      json(res, 400, { error: "invalid_request", error_description: "redirect_uri must be https or loopback" });
      return;
    }

    const tx = sign({ rd: redirectUri, cc: codeChallenge, st: state, exp: Math.floor(Date.now() / 1000) + 600 }, key);
    setTxCookie(res, tx);

    const dest = new URL(ssoAuthorizeUrl);
    dest.searchParams.set("return_origin", base);
    dest.searchParams.set("from", "/oauth/idp-callback");
    res.writeHead(302, { Location: dest.toString(), "Cache-Control": "no-store" });
    res.end();
  };

  // GET /oauth/idp-callback  (token arrives in the URL fragment)
  const handleIdpCallback = (req, res) => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Signing in…</title></head>
<body style="font-family:system-ui;margin:2rem">
<p id="m">Completing sign-in…</p>
<script>
(function(){
  var h = new URLSearchParams((location.hash||"").replace(/^#/, ""));
  var t = h.get("sso_token");
  var e = h.get("sso_error");
  var m = document.getElementById("m");
  if (e) { m.textContent = "Sign-in failed: " + e; return; }
  if (!t) { m.textContent = "Sign-in failed: no token."; return; }
  fetch("/oauth/finish", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: t }) })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
    .then(function(x){
      if (x.ok && x.j.redirect) { location.replace(x.j.redirect); }
      else { m.textContent = "Sign-in failed: " + (x.j && x.j.error_description || x.j && x.j.error || "unknown error"); }
    })
    .catch(function(){ m.textContent = "Sign-in failed: network error."; });
})();
</script>
</body></html>`;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  };

  // POST /oauth/finish  { token }  (called by the idp-callback script)
  const handleFinish = async (req, res) => {
    const cookies = parseCookies(req);
    const tx = verify(cookies[TX_COOKIE], key);
    if (!tx) {
      json(res, 400, { error: "invalid_request", error_description: "missing or expired login transaction" });
      return;
    }
    const body = parseForm(await readBody(req), req.headers["content-type"]);
    const token = body.token;
    if (typeof token !== "string" || token.length < 16) {
      json(res, 400, { error: "invalid_request", error_description: "missing token" });
      return;
    }
    // Validate the minted JWT against the backend before we vouch for it.
    let ok = false;
    try {
      const r = await fetch(`${validateUrl}/api/namespaces`, { headers: { Authorization: `Bearer ${token}` } });
      ok = r.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      json(res, 401, { error: "access_denied", error_description: "token rejected by backend" });
      return;
    }
    clearTxCookie(res);
    const code = seal({ tok: token, cc: tx.cc, rd: tx.rd, exp: Math.floor(Date.now() / 1000) + 120 }, key);
    const sep = tx.rd.includes("?") ? "&" : "?";
    const redirect = `${tx.rd}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(tx.st || "")}`;
    json(res, 200, { redirect });
  };

  // POST /oauth/token
  const handleToken = async (req, res) => {
    const body = parseForm(await readBody(req), req.headers["content-type"]);
    if (body.grant_type !== "authorization_code") {
      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }
    const code = unseal(body.code, key);
    if (!code) {
      json(res, 400, { error: "invalid_grant", error_description: "invalid or expired code" });
      return;
    }
    if (!body.redirect_uri || body.redirect_uri !== code.rd) {
      json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
      return;
    }
    if (!pkceMatches(body.code_verifier, code.cc)) {
      json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      return;
    }
    // Best-effort expiry from the JWT's own exp claim.
    let expiresIn = 3600;
    try {
      const claims = JSON.parse(Buffer.from(code.tok.split(".")[1], "base64url").toString("utf8"));
      if (claims.exp) expiresIn = Math.max(60, claims.exp - Math.floor(Date.now() / 1000));
    } catch {
      /* keep default */
    }
    json(res, 200, { access_token: code.tok, token_type: "Bearer", expires_in: expiresIn, scope: "mdnest" });
  };

  // POST /oauth/register  (Dynamic Client Registration — public PKCE clients)
  const handleRegister = async (req, res) => {
    const body = parseForm(await readBody(req), req.headers["content-type"]);
    const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    json(res, 201, {
      client_id: `mcp-${b64url(createHmac("sha256", key).update(JSON.stringify(redirectUris) + Date.now()).digest()).slice(0, 24)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  };

  // Dispatch OAuth + discovery routes. Returns true if the request was handled.
  const handle = (req, res, url) => {
    const p = url.pathname;
    if (req.method === "GET" && (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource" + mcpPath)) {
      json(res, 200, protectedResourceMeta);
      return true;
    }
    if (req.method === "GET" && (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/oauth-authorization-server" + mcpPath)) {
      json(res, 200, authServerMeta);
      return true;
    }
    if (req.method === "GET" && p === "/oauth/authorize") {
      handleAuthorize(req, res, url);
      return true;
    }
    if (req.method === "GET" && p === "/oauth/idp-callback") {
      handleIdpCallback(req, res);
      return true;
    }
    if (req.method === "POST" && p === "/oauth/finish") {
      handleFinish(req, res).catch(() => json(res, 500, { error: "server_error" }));
      return true;
    }
    if (req.method === "POST" && p === "/oauth/token") {
      handleToken(req, res).catch(() => json(res, 500, { error: "server_error" }));
      return true;
    }
    if (req.method === "POST" && p === "/oauth/register") {
      handleRegister(req, res).catch(() => json(res, 500, { error: "server_error" }));
      return true;
    }
    return false;
  };

  // Extract the bearer token from an MCP request, or null.
  const bearer = (req) => {
    const h = req.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : null;
  };

  // Write a 401 that points the client at the protected-resource metadata.
  const challenge = (res, jsonRpcError) => {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    });
    res.end(jsonRpcError);
  };

  return { handle, bearer, challenge };
}
