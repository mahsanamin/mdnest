// Smoke test for MCP feature-gating. Stands up a fake mdnest backend whose
// GET /api/config enables the task board and Excalidraw but NOT Marp, then
// asserts tools/list advertises the task + drawing tools and hides the Marp
// ones — i.e. the MCP surface mirrors what the backend has enabled.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BACKEND_PORT = 8291;
const MCP_PORT = 3190;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

// Fake backend: only /api/config is needed (tools/list never calls the backend).
const backend = createServer((req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/config")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authMode: "single", taskBoard: true, excalidraw: true })); // marp intentionally absent
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end("{}");
});

const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
async function toolNames() {
  const r = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: rpc,
  });
  const text = await r.text();
  // The streamable-HTTP response may be a raw JSON body or an SSE frame.
  const jsonStr = text.includes("data:") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : text;
  let names = [];
  try {
    names = (JSON.parse(jsonStr).result?.tools || []).map((t) => t.name);
  } catch {
    names = null;
  }
  return { status: r.status, names, text };
}

async function run() {
  const { status, names, text } = await toolNames();
  ok("tools/list -> 200", status === 200, `status=${status}`);
  if (!names) { ok("parse tools/list", false, text.slice(0, 120)); return; }
  const has = (n) => names.includes(n);
  // Always-on note tools.
  ok("core note tool present", has("list_namespaces"));
  // Gated ON in the fake config.
  ok("task tools present (taskBoard on)", has("list_tasks") && has("delete_task") && has("search_tasks"));
  ok("excalidraw tool present (excalidraw on)", has("create_excalidraw"));
  // Gated OFF (marp absent from config).
  ok("marp tools hidden (marp off)", !has("create_marp") && !has("add_marp_slide"), names.filter((n) => n.includes("marp")).join(",") || "none");
}

// --- orchestrate ----------------------------------------------------------
backend.listen(BACKEND_PORT, "127.0.0.1", () => {
  const child = spawn("node", ["index.js"], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_HTTP_PORT: String(MCP_PORT),
      MCP_HTTP_HOST: "127.0.0.1",
      MCP_AUTH_MODE: "bearer",
      MDNEST_TOKEN: TOKEN,
      MDNEST_URL: `http://127.0.0.1:${BACKEND_PORT}`,
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
  // give the server a moment to bind + read /api/config
  setTimeout(done, 900);
});
