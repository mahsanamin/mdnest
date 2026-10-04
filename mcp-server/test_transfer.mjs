// End-to-end test for the cross-namespace MCP tools: move_item with a
// targetNamespace and copy_item go to POST /api/transfer with the right body;
// move_item without one keeps using /api/move; a backend refusal (409) comes
// back as a tool error that names the collision.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BACKEND_PORT = 8293;
const MCP_PORT = 3192;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

// --- fake backend: records what each request asked for ----------------------
let last = null;
const backend = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    if (req.method === "GET" && url.pathname === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ authMode: "single" }));
      return;
    }
    last = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null };
    if (url.pathname === "/api/transfer" && last.body?.to?.path === "taken.md") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "exists", path: "taken.md" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
});

let rpcId = 0;
async function callTool(name, args) {
  const r = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  const jsonStr = text.includes("data:") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : text;
  const result = JSON.parse(jsonStr).result || {};
  return { isError: !!result.isError, text: result.content?.[0]?.text ?? "" };
}

async function run() {
  let r = await callTool("move_item", { namespace: "personal", from: "Notes/x.md", to: "Project/x.md", targetNamespace: "shared" });
  ok("move_item with targetNamespace succeeds", !r.isError, r.text);
  ok("...goes to /api/transfer", last?.path === "/api/transfer" && last.method === "POST");
  ok("...with mode move and both sides", JSON.stringify(last?.body) === JSON.stringify({ mode: "move", from: { ns: "personal", path: "Notes/x.md" }, to: { ns: "shared", path: "Project/x.md" } }), JSON.stringify(last?.body));

  r = await callTool("move_item", { namespace: "personal", from: "a.md", to: "b.md" });
  ok("move_item without targetNamespace keeps /api/move", !r.isError && last?.path === "/api/move" && last.query.ns === "personal" && last.query.from === "a.md" && last.query.to === "b.md", JSON.stringify(last));

  r = await callTool("move_item", { namespace: "personal", from: "a.md", to: "b.md", targetNamespace: "personal" });
  ok("move_item with the same namespace keeps /api/move", last?.path === "/api/move");

  r = await callTool("copy_item", { namespace: "personal", from: "F", to: "F", targetNamespace: "shared" });
  ok("copy_item crosses namespaces", !r.isError && last?.path === "/api/transfer" && last.body.mode === "copy" && last.body.to.ns === "shared", JSON.stringify(last?.body));

  r = await callTool("copy_item", { namespace: "personal", from: "a.md", to: "a copy.md" });
  ok("copy_item defaults to the source namespace", last?.body?.to?.ns === "personal" && last.body.to.path === "a copy.md");

  r = await callTool("copy_item", { namespace: "personal", from: "a.md", to: "taken.md", targetNamespace: "shared" });
  ok("a 409 is a tool error naming the collision", r.isError && r.text.includes("409") && r.text.includes("taken.md"), r.text);
}

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
  setTimeout(done, 900);
});
