// MCP milestone tools against a fake backend: save_milestone adds or updates a
// milestone in the board sidecar without touching the columns, delete_milestone
// removes one, and the task tools pass `milestone` through.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BACKEND_PORT = 8297;
const MCP_PORT = 3196;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

const columns = [{ id: "todo", title: "To Do" }, { id: "done", title: "Done", done: true }];
let board = { version: 1, columns, defaultNote: "tasks.md", milestones: [{ id: "m1", title: "Reset" }] };
const posted = [];
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });

const backend = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.method === "GET" && url.pathname === "/api/config") return json(200, { authMode: "single", taskBoard: true });
  if (req.method === "GET" && url.pathname === "/api/board") return json(200, board);
  if (req.method === "PUT" && url.pathname === "/api/board") {
    const next = JSON.parse(await readBody(req));
    if ((next.milestones || []).some((m) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.id))) return json(400, { error: "milestone id must be letters, digits, '.', '_' or '-'" });
    board = next;
    return json(200, board);
  }
  if (req.method === "POST" && url.pathname === "/api/tasks") {
    posted.push(JSON.parse(await readBody(req)));
    return json(201, { text: "t", milestone: posted.at(-1).milestone });
  }
  return json(404, {});
});

let id = 0;
async function rpc(method, params) {
  const r = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await r.text();
  const jsonStr = text.includes("data:") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : text;
  return JSON.parse(jsonStr).result;
}
const call = async (name, args) => {
  const r = await rpc("tools/call", { name, arguments: args });
  return { isError: !!r?.isError, text: (r?.content || []).map((c) => c.text).join("\n") };
};

async function run() {
  const tools = (await rpc("tools/list", {})).tools;
  ok("milestone tools are offered with the task board", ["save_milestone", "delete_milestone"].every((n) => tools.some((t) => t.name === n)));
  const setField = tools.find((t) => t.name === "set_task_field");
  ok("set_task_field accepts milestone", JSON.stringify(setField?.inputSchema || {}).includes('"milestone"'));

  const add = await call("save_milestone", { namespace: "ns", id: "m2-ci", title: "CI", due: "2026-11-30" });
  ok("a new milestone is appended", !add.isError && board.milestones.map((m) => m.id).join() === "m1,m2-ci", add.text);
  ok("the columns and default note are kept", board.columns.length === 2 && board.defaultNote === "tasks.md");

  await call("save_milestone", { namespace: "ns", id: "m1", title: "Reset done", closed: true });
  ok("an existing id is updated in place", board.milestones[0].title === "Reset done" && board.milestones[0].closed === true && board.milestones.length === 2);

  const bad = await call("save_milestone", { namespace: "ns", id: "bad id", title: "x" });
  ok("the server's validation error is returned", bad.isError && /milestone id/.test(bad.text), bad.text);

  await call("create_task", { namespace: "ns", title: "Shard promtool", milestone: "m2-ci" });
  ok("create_task passes the milestone", posted.at(-1)?.milestone === "m2-ci");

  const del = await call("delete_milestone", { namespace: "ns", id: "m1" });
  ok("delete_milestone removes it", !del.isError && board.milestones.map((m) => m.id).join() === "m2-ci");
  const missing = await call("delete_milestone", { namespace: "ns", id: "nope" });
  ok("deleting an unknown milestone says so", missing.isError && /No milestone "nope"/.test(missing.text));
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
