// Smoke test for the MCP bearer auth mode. Runs the real mcp-server with
// MCP_AUTH_MODE=bearer and a static mdnest API token, then asserts the endpoint
// rejects missing/wrong tokens (401) and accepts the configured token (200).
import { spawn } from "node:child_process";

const MCP_PORT = 3188;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
async function mcp(headers) {
  const r = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: rpc,
  });
  const text = await r.text();
  return { status: r.status, wwwAuth: r.headers.get("www-authenticate") || "", text };
}

async function run() {
  // No OAuth discovery endpoints in bearer mode.
  let r = await fetch(`${MCP_BASE}/.well-known/oauth-protected-resource`);
  ok("no OAuth discovery in bearer mode", r.status === 404, `status=${r.status}`);

  let x = await mcp({});
  ok("no token -> 401", x.status === 401 && x.wwwAuth.includes("Bearer"), `status=${x.status}`);

  x = await mcp({ Authorization: "Bearer wrong-token" });
  ok("wrong token -> 401", x.status === 401, `status=${x.status}`);

  x = await mcp({ Authorization: `Bearer ${TOKEN}` });
  ok("correct token -> 200", x.status === 200 && x.text.includes("list_namespaces"), `status=${x.status}`);
}

// --- orchestrate ----------------------------------------------------------
const child = spawn("node", ["index.js"], {
  env: {
    ...process.env,
    MCP_TRANSPORT: "http",
    MCP_HTTP_PORT: String(MCP_PORT),
    MCP_HTTP_HOST: "127.0.0.1",
    MCP_AUTH_MODE: "bearer",
    MDNEST_TOKEN: TOKEN,
    // Unreachable backend: tools/list is served locally, so the endpoint never
    // needs to reach it for this test.
    MDNEST_URL: "http://127.0.0.1:1",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

const done = async () => {
  try { await run(); } catch (e) { console.log("FAIL  harness error ->", e.message); failed++; }
  child.kill("SIGKILL");
  console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
};
// give the server a moment to bind
setTimeout(done, 800);
