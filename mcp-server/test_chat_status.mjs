// set_chat_status: posts the text to /api/chat/status with the poster's name,
// an empty text clears, and a backend refusal comes back as a tool error.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BACKEND_PORT = 8295;
const MCP_PORT = 3194;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

let last = null;
const backend = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (code, text) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(text); };
    if (url.pathname === "/api/config") return send(200, JSON.stringify({ authMode: "single", chat: true }));
    last = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body };
    if (url.searchParams.get("path") === "Private/room.md") return send(403, JSON.stringify({ error: "forbidden" }));
    send(200, JSON.stringify({ status: "ok" }));
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
  let r = await callTool("set_chat_status", { namespace: "ws", path: "Chats/r.md", text: "reviewing the PR", as: "codxu" });
  ok("sets a status", !r.isError && r.text === "status set: reviewing the PR", r.text);
  ok("...on /api/chat/status with ns, path and as", last?.method === "POST" && last.path === "/api/chat/status" && last.query.ns === "ws" && last.query.path === "Chats/r.md" && last.query.as === "codxu", JSON.stringify(last));
  ok("...with the text as the body", last?.body === "reviewing the PR", last?.body);

  r = await callTool("set_chat_status", { namespace: "ws", path: "Chats/r.md", text: "", as: "codxu" });
  ok("an empty text clears", !r.isError && r.text === "status cleared" && last?.body === "", r.text);

  r = await callTool("set_chat_status", { namespace: "ws", path: "Private/room.md", text: "x", as: "codxu" });
  ok("a refusal is a tool error", r.isError && r.text.includes("403"), r.text);
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
