// Smoke test for the MCP OAuth bridge. Spins a fake mdnest backend (SSO start +
// /api/namespaces), runs the real mcp-server in oauth mode, and drives the full
// OAuth 2.1 authorization-code + PKCE flow, then an authenticated MCP call.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");
const JWT = "header." + b64url(JSON.stringify({ sub: "alice", user_id: 7, role: "collaborator", exp: Math.floor(Date.now() / 1000) + 3600 })) + ".sig";

const MCP_PORT = 3071;
const BE_PORT = 8299;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const BE_BASE = `http://127.0.0.1:${BE_PORT}`;
const CLIENT_REDIRECT = "http://127.0.0.1:9999/callback";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

// --- fake backend ---------------------------------------------------------
const backend = createServer((req, res) => {
  const url = new URL(req.url, BE_BASE);
  if (url.pathname === "/api/auth/sso/start") {
    // Simulate a successful Entra login: bounce straight back to the return
    // origin's callback with a minted JWT in the fragment.
    const ro = url.searchParams.get("return_origin");
    const from = url.searchParams.get("from") || "/";
    res.writeHead(302, { Location: `${ro}${from}#sso_token=${encodeURIComponent(JWT)}` });
    res.end();
    return;
  }
  if (url.pathname === "/api/namespaces") {
    const auth = req.headers["authorization"] || "";
    if (auth === `Bearer ${JWT}`) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(["ns1"])); }
    else { res.writeHead(401); res.end("no"); }
    return;
  }
  res.writeHead(404); res.end("nope");
});

function getCookie(setCookieHeaders, name) {
  for (const h of setCookieHeaders || []) {
    const m = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(h) || new RegExp(`^${name}=([^;]*)`).exec(h);
    if (m) return m[1];
  }
  return null;
}

async function run() {
  // 1. discovery
  let r = await fetch(`${MCP_BASE}/.well-known/oauth-protected-resource`);
  let j = await r.json();
  ok("protected-resource metadata", r.ok && j.authorization_servers?.[0] === MCP_BASE, JSON.stringify(j));

  r = await fetch(`${MCP_BASE}/.well-known/oauth-authorization-server`);
  j = await r.json();
  ok("authorization-server metadata", r.ok && j.authorization_endpoint === `${MCP_BASE}/oauth/authorize` && j.code_challenge_methods_supported?.includes("S256"));

  // 2. authorize (PKCE)
  const verifier = b64url(randomBytes(40));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authUrl = `${MCP_BASE}/oauth/authorize?response_type=code&client_id=c1&redirect_uri=${encodeURIComponent(CLIENT_REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`;
  r = await fetch(authUrl, { redirect: "manual" });
  const txCookie = getCookie(r.headers.getSetCookie?.() || [r.headers.get("set-cookie")], "mcp_oauth_tx");
  const loc = r.headers.get("location");
  ok("authorize -> 302 to SSO start", r.status === 302 && loc?.startsWith(`${BE_BASE}/api/auth/sso/start`), loc);
  ok("authorize sets tx cookie", !!txCookie);
  const locUrl = new URL(loc);
  ok("authorize passes return_origin+from", locUrl.searchParams.get("return_origin") === MCP_BASE && locUrl.searchParams.get("from") === "/oauth/idp-callback");

  // 3. backend SSO -> redirect to idp-callback with token in fragment
  r = await fetch(loc, { redirect: "manual" });
  const beLoc = r.headers.get("location");
  ok("SSO start -> idp-callback with token", r.status === 302 && beLoc?.startsWith(`${MCP_BASE}/oauth/idp-callback#sso_token=`), beLoc);

  // 4. finish (simulates the callback page's POST) with tx cookie
  r = await fetch(`${MCP_BASE}/oauth/finish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `mcp_oauth_tx=${txCookie}` },
    body: JSON.stringify({ token: JWT }),
  });
  j = await r.json();
  ok("finish -> redirect with code", r.ok && typeof j.redirect === "string" && j.redirect.startsWith(CLIENT_REDIRECT), JSON.stringify(j));
  const code = new URL(j.redirect).searchParams.get("code");
  const stateBack = new URL(j.redirect).searchParams.get("state");
  ok("finish preserves state", stateBack === "xyz");

  // 5. token exchange (PKCE verifier)
  r = await fetch(`${MCP_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CLIENT_REDIRECT }),
  });
  j = await r.json();
  ok("token -> access_token = mdnest JWT", r.ok && j.access_token === JWT && j.token_type === "Bearer", JSON.stringify(j).slice(0, 80));

  // 5b. token exchange with WRONG verifier must fail
  r = await fetch(`${MCP_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong", redirect_uri: CLIENT_REDIRECT }),
  });
  ok("token rejects bad PKCE verifier", r.status === 400);

  // --- redirect_uri must not be attacker-choosable -------------------------
  // A code delivered to an attacker's origin is a stolen mdnest JWT, and PKCE
  // cannot prevent it (a malicious client holds its own verifier). Loopback is
  // always allowed; any other origin needs MCP_ALLOWED_REDIRECT_ORIGINS.
  const authorizeWith = async (uri) => {
    const resp = await fetch(
      `${MCP_BASE}/oauth/authorize?response_type=code&code_challenge=${challenge}` +
        `&code_challenge_method=S256&redirect_uri=${encodeURIComponent(uri)}`,
      { redirect: "manual" }
    );
    // Drain the body: an unconsumed response keeps undici's connection busy and
    // stalls the requests that follow.
    await resp.arrayBuffer().catch(() => {});
    return resp;
  };

  r = await authorizeWith("https://evil.example.com/callback");
  ok("authorize rejects a non-allowlisted https redirect_uri", r.status === 400, `got ${r.status}`);

  r = await authorizeWith("http://evil.example.com/callback");
  ok("authorize rejects a plain-http remote redirect_uri", r.status === 400, `got ${r.status}`);

  r = await authorizeWith("http://127.0.0.1:9999/callback");
  ok("authorize still accepts a loopback redirect_uri", r.status === 302, `got ${r.status}`);

  r = await authorizeWith("http://localhost:9999/callback");
  ok("authorize still accepts localhost", r.status === 302, `got ${r.status}`);

  // 6. MCP call without bearer -> 401 + WWW-Authenticate
  r = await fetch(`${MCP_BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
  ok("MCP without token -> 401", r.status === 401 && (r.headers.get("www-authenticate") || "").includes("resource_metadata"));

  // 6b. MCP initialize WITH bearer -> 200
  r = await fetch(`${MCP_BASE}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${JWT}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) });
  const txt = await r.text();
  ok("MCP initialize with token -> 200", r.status === 200 && txt.includes("mdnest"), `status=${r.status}`);
}

// --- orchestrate ----------------------------------------------------------
backend.listen(BE_PORT, "127.0.0.1", () => {
  const child = spawn("node", ["index.js"], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HTTP_PORT: String(MCP_PORT),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_AUTH_MODE: "oauth",
      MCP_PUBLIC_URL: MCP_BASE,
      MCP_OAUTH_SECRET: "test-secret-please-change",
      MCP_SSO_AUTHORIZE_URL: `${BE_BASE}/api/auth/sso/start`,
      MDNEST_URL: BE_BASE,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const done = async () => {
    try { await run(); } catch (e) { console.log("FAIL  harness error ->", e.message); failed++; }
    child.kill("SIGKILL");
    backend.close();
    console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  };
  // give the server a moment to bind
  setTimeout(done, 800);
});
