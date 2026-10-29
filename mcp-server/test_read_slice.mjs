// End-to-end test for read_note's partial reads. Stands up a fake mdnest
// backend that serves one note, then drives the MCP tool over streamable-HTTP:
// outline, section (exact, partial, nested, headings inside code fences),
// offset/limit, and the plain full read staying unchanged.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const BACKEND_PORT = 8296;
const MCP_PORT = 3195;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

// --- fake backend: one in-memory note ---------------------------------------
const NOTE = [
  "# Title",          // 1
  "intro",            // 2
  "## Setup",         // 3
  "setup body",       // 4
  "```sh",            // 5
  "# not a heading",  // 6
  "```",              // 7
  "### Setup details",// 8
  "details",          // 9
  "## Usage",         // 10
  "usage body",       // 11
  "## C#",            // 12  a '#' that is part of the title, not a closing sequence
  "c body",           // 13
].join("\n") + "\n";  // trailing newline, as editors save it

const backend = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ authMode: "single" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/note") {
    res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
    res.end(NOTE);
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
      params: { name: "read_note", arguments: { namespace: "wiki", path: "guide.md", ...args } },
    }),
  });
  const text = await r.text();
  const jsonStr = text.includes("data:") ? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1) : text;
  const result = JSON.parse(jsonStr).result || {};
  return { isError: !!result.isError, text: result.content?.[0]?.text ?? "" };
}

const show = (s) => s.replace(/\n/g, "\\n");

async function run() {
  // 1. no options: the whole note, unchanged
  let r = await callTool({});
  ok("plain read returns the whole note", !r.isError && r.text === NOTE, show(r.text));

  // 2. outline: line count and headings with line numbers, fenced '#' skipped
  r = await callTool({ outline: true });
  const wantOutline = "13 lines\n1: # Title\n3: ## Setup\n8: ### Setup details\n10: ## Usage\n12: ## C#";
  ok("outline lists headings with line numbers", !r.isError && r.text === wantOutline, show(r.text));

  // 3. section: exact title, runs to the next heading of same or higher level
  r = await callTool({ section: "Setup" });
  ok("section takes nested headings and fenced code", !r.isError && r.text === `[lines 3-9]\n${NOTE.split("\n").slice(2, 9).join("\n")}`, show(r.text));

  // 4. section: a leading '##' and letter case are ignored
  r = await callTool({ section: "## setup details" });
  ok("'##' prefix and case ignored",!r.isError && r.text === "[lines 8-9]\n### Setup details\ndetails", show(r.text));

  // 5. section: partial match
  r = await callTool({ section: "usa" });
  ok("partial match", !r.isError && r.text === "[lines 10-11]\n## Usage\nusage body", show(r.text));

  // 5b. last section runs to the end of the note; '#' inside the title kept
  r = await callTool({ section: "C#" });
  ok("last section to end, '#' in title", !r.isError && r.text === "[lines 12-13]\n## C#\nc body", show(r.text));

  // 6. section not found: error pointing at outline
  r = await callTool({ section: "Nope" });
  ok("missing section errors", r.isError && r.text.includes("not found"), r.text);

  // 7. offset/limit: 1-indexed, clamped to the note
  r = await callTool({ offset: 12, limit: 5 });
  ok("offset+limit clamps to the note", !r.isError && r.text === "[lines 12-13 of 13]\n## C#\nc body", show(r.text));
  r = await callTool({ limit: 2 });
  ok("limit alone starts at line 1", !r.isError && r.text === "[lines 1-2 of 13]\n# Title\nintro", show(r.text));
  r = await callTool({ offset: 20 });
  ok("offset past the end errors", r.isError && r.text.includes("past the end"), r.text);
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
