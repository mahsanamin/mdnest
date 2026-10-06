// set_chat_avatar with pick "auto": the first built-in nobody else in the
// namespace wears (matched by content, since an avatar is a copy of the
// built-in), the caller's own current avatar does not count, and when every
// built-in is taken it still sets one and says so.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BACKEND_PORT = 8294;
const MCP_PORT = 3193;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

const BUILTIN = Object.fromEntries(["robot", "owl", "cat"].map((n) => [n, `<svg xmlns="http://www.w3.org/2000/svg"><title>${n}</title></svg>`]));
let worn = {};      // poster -> built-in their avatar copies
let written = null; // { path, as } of the last avatar write

const backend = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const send = (code, text, type = "application/json") => { res.writeHead(code, { "Content-Type": type }); res.end(text); };
    if (url.pathname === "/api/config") return send(200, JSON.stringify({ authMode: "single", chat: true }));
    if (url.pathname === "/api/chat/gifs") {
      const gifs = Object.keys(worn).map((who) => ({ name: `avatar-${who}`, path: `ChatGifs/avatar-${who}.svg`, scope: "workspace", avatar: who }))
        .concat(Object.keys(BUILTIN).map((n) => ({ name: n, path: `/api/chat/gifs/builtin/avatars/${n}.svg`, scope: "builtin", kind: "avatar-choice" })));
      return send(200, JSON.stringify({ gifs }));
    }
    if (url.pathname.startsWith("/api/chat/gifs/builtin/avatars/")) {
      const n = url.pathname.split("/").pop().replace(/\.svg$/, "");
      return BUILTIN[n] ? send(200, BUILTIN[n], "image/svg+xml") : send(404, "");
    }
    if (url.pathname === "/api/note") {
      const p = url.searchParams.get("path");
      const who = p.replace(/^ChatGifs\/avatar-/, "").replace(/\.svg$/, "");
      if (req.method === "GET") return worn[who] ? send(200, BUILTIN[worn[who]] + "\n", "text/markdown") : send(404, "{}");
      written = { path: p, as: Object.keys(BUILTIN).find((k) => BUILTIN[k] === body) || body };
      return send(201, JSON.stringify({ status: "created" }));
    }
    send(404, "{}");
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
  worn = { alice: "robot", bob: "owl", codxu: "cat" };
  let r = await callTool("set_chat_avatar", { namespace: "ws", as: "codxu", pick: "auto" });
  ok("auto keeps the caller's own avatar when it is the only free one", !r.isError && written?.as === "cat" && written.path === "ChatGifs/avatar-codxu.svg", JSON.stringify(written));

  worn = { alice: "robot" };
  r = await callTool("set_chat_avatar", { namespace: "ws", as: "newbie", pick: "auto" });
  ok("auto skips a built-in someone else wears", !r.isError && written?.as === "owl", JSON.stringify(written));
  ok("...and names the one it picked", r.text.includes("(owl)"), r.text);

  worn = { a: "robot", b: "owl", c: "cat" };
  r = await callTool("set_chat_avatar", { namespace: "ws", as: "late", pick: "auto" });
  ok("all taken: it still sets the first one", !r.isError && written?.as === "robot", JSON.stringify(written));
  ok("...and says every built-in is in use", r.text.includes("already in use"), r.text);

  r = await callTool("set_chat_avatar", { namespace: "ws", as: "x", pick: "owl" });
  ok("a named pick still works", !r.isError && written?.as === "owl", JSON.stringify(written));
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
