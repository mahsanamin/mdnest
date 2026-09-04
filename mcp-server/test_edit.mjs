// End-to-end test for edit_note. Stands up a fake mdnest backend that serves a
// note with an ETag and enforces If-Match on write, then drives the MCP tool
// over streamable-HTTP: exact replace, missing/ambiguous old_string,
// replace_all, literal $-handling, and the concurrent-save conflict.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const BACKEND_PORT = 8292;
const MCP_PORT = 3191;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

// --- fake backend: one in-memory note behind ETag/If-Match -----------------
const INITIAL = "# Log\n\nalpha\nbeta\nalpha\n";
let note = INITIAL;
// When set, the note is mutated right after the next GET responds — a stand-in
// for another client saving between this tool's read and its write.
let raceOnNextRead = false;
const etagOf = (s) => `"${createHash("sha256").update(s).digest("hex")}"`;

const backend = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authMode: "single" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/note") {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", ETag: etagOf(note) });
    res.end(note);
    if (raceOnNextRead) { note = note + "\nwritten by someone else\n"; raceOnNextRead = false; }
    return;
  }
  if (req.method === "PUT" && url.pathname === "/api/note") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const ifMatch = req.headers["if-match"];
      if (ifMatch && ifMatch !== etagOf(note)) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "file was modified by another user", etag: etagOf(note) }));
        return;
      }
      note = body;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", etag: etagOf(note) }));
    });
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end("{}");
});

// --- MCP client ------------------------------------------------------------
let rpcId = 0;
async function callTool(args) {
  const r = await fetch(`${MCP_BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: ++rpcId, method: "tools/call",
      params: { name: "edit_note", arguments: { namespace: "wiki", path: "log.md", ...args } },
    }),
  });
  const text = await r.text();
  const jsonStr = text.includes("data:") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : text;
  const result = JSON.parse(jsonStr).result || {};
  return { isError: !!result.isError, text: result.content?.[0]?.text ?? "" };
}

async function run() {
  // 1. unique match: replaces just that one, rest of the file untouched
  note = INITIAL;
  let r = await callTool({ old_string: "beta", new_string: "BETA" });
  ok("unique match edits the note", !r.isError && note === "# Log\n\nalpha\nBETA\nalpha\n", note.replace(/\n/g, "\\n"));
  ok("reports one replacement", r.text.includes('"replacements":1'), r.text);

  // 2. missing old_string: error, note untouched
  note = INITIAL;
  r = await callTool({ old_string: "gamma", new_string: "x" });
  ok("missing old_string errors", r.isError && r.text.includes("not found"), r.text);
  ok("missing old_string leaves note untouched", note === INITIAL);

  // 3. ambiguous old_string: error naming the count, note untouched
  note = INITIAL;
  r = await callTool({ old_string: "alpha", new_string: "x" });
  ok("ambiguous old_string errors with count", r.isError && r.text.includes("occurs 2 times"), r.text);
  ok("ambiguous old_string leaves note untouched", note === INITIAL);

  // 4. replace_all: every occurrence, count reported
  note = INITIAL;
  r = await callTool({ old_string: "alpha", new_string: "x", replace_all: true });
  ok("replace_all replaces every occurrence", !r.isError && note === "# Log\n\nx\nbeta\nx\n", note.replace(/\n/g, "\\n"));
  ok("replace_all reports the count", r.text.includes('"replacements":2'), r.text);

  // 5. $ patterns in new_string are literal (String.replace would expand $&)
  note = INITIAL;
  r = await callTool({ old_string: "beta", new_string: "cost: $& and $1" });
  ok("$ patterns stay literal", !r.isError && note.includes("cost: $& and $1"), note.replace(/\n/g, "\\n"));

  // 6. concurrent save between read and write: refused, not clobbered
  note = INITIAL;
  raceOnNextRead = true;
  r = await callTool({ old_string: "beta", new_string: "BETA" });
  ok("concurrent save is refused", r.isError && r.text.includes("modified by another user"), r.text);
  ok("concurrent save is not clobbered", note.includes("written by someone else"), note.replace(/\n/g, "\\n"));

  // 7. guards
  note = INITIAL;
  r = await callTool({ old_string: "", new_string: "x" });
  ok("empty old_string errors", r.isError && r.text.includes("must not be empty"), r.text);
  r = await callTool({ old_string: "beta", new_string: "beta" });
  ok("identical strings error", r.isError && r.text.includes("identical"), r.text);
  ok("guards leave note untouched", note === INITIAL);
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
  setTimeout(done, 900);
});
