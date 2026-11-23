// MCP pages tools against a fake backend that records what it receives.
// publish_page with extra files must send a tar the system tar reads back
// byte for byte (long paths and binary files included); with only html it
// sends text/html. read_page and list_pages pass the namespace through.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BACKEND_PORT = 8297;
const MCP_PORT = 3197;
const MCP_BASE = `http://127.0.0.1:${MCP_PORT}`;
const TOKEN = "mdnest_static_test_token";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

const seen = [];
const backend = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    seen.push({ method: req.method, url: req.url, ct: req.headers["content-type"], body: Buffer.concat(chunks) });
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.startsWith("/api/config")) return res.end(JSON.stringify({ authMode: "single", pages: { enabled: true, scripts: false } }));
    if (req.url.startsWith("/api/pages/text")) return res.end(JSON.stringify({ slug: "q3", title: "Q3", text: "Revenue grew" }));
    if (req.url.startsWith("/api/pages?") && req.method === "GET") return res.end(JSON.stringify({ pages: [{ slug: "q3", title: "Q3" }] }));
    res.end(JSON.stringify({ slug: "q3", title: "Q3", files: 3 }));
  });
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
  return JSON.parse(jsonStr);
}
const call = (name, args) => rpc("tools/call", { name, arguments: args });

async function run() {
  const names = (await rpc("tools/list", {})).result.tools.map((t) => t.name);
  ok("pages tools offered when pages are on", ["publish_page", "list_pages", "read_page"].every((n) => names.includes(n)));

  // html only: text/html, body is the html.
  let r = await call("publish_page", { namespace: "alpha", slug: "q3", html: "<p>hi</p>" });
  let put = seen.filter((s) => s.method === "PUT").pop();
  ok("html-only publish succeeds", !r.result.isError, JSON.stringify(r.result).slice(0, 120));
  ok("html-only publish is text/html", put?.ct?.startsWith("text/html") && put.body.toString() === "<p>hi</p>");
  ok("namespace and slug are in the query", put?.url === "/api/pages?ns=alpha&slug=q3", put?.url);

  // with files: a tar the system tar reads back exactly.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255, 254]);
  const longPath = "assets/" + "d".repeat(80) + "/" + "f".repeat(60) + ".json";
  r = await call("publish_page", {
    namespace: "alpha", slug: "q3", html: "<title>Q3</title><img src=img/c.png>",
    files: [
      { path: "img/c.png", content: png.toString("base64"), encoding: "base64" },
      { path: longPath, content: '{"a":"é"}' },
    ],
  });
  put = seen.filter((s) => s.method === "PUT").pop();
  ok("publish with files succeeds", !r.result.isError, JSON.stringify(r.result).slice(0, 120));
  ok("publish with files is a tar", put?.ct === "application/x-tar");
  const dir = mkdtempSync(join(tmpdir(), "mcp-pages-"));
  try {
    writeFileSync(join(dir, "p.tar"), put.body);
    execFileSync("tar", ["-xf", "p.tar"], { cwd: dir });
    ok("tar: index.html", readFileSync(join(dir, "index.html"), "utf8") === "<title>Q3</title><img src=img/c.png>");
    ok("tar: binary file byte-exact", readFileSync(join(dir, "img/c.png")).equals(png));
    ok("tar: long path and utf8 content", readFileSync(join(dir, longPath), "utf8") === '{"a":"é"}');
  } catch (e) {
    ok("system tar reads the archive", false, e.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  r = await call("publish_page", { namespace: "alpha", slug: "Bad_Name", html: "x" });
  ok("bad slug refused before any request", r.result?.isError || !!r.error);

  r = await call("read_page", { namespace: "alpha", slug: "q3" });
  ok("read_page returns the text", r.result.content[0].text.includes("Revenue grew"));
  ok("read_page asks for the text endpoint", seen.some((s) => s.url === "/api/pages/text?ns=alpha&slug=q3"));
  r = await call("list_pages", { namespace: "alpha", query: "rev grew" });
  ok("list_pages passes the query", seen.some((s) => s.url === "/api/pages?ns=alpha&q=rev%20grew"));
}

backend.listen(BACKEND_PORT, "127.0.0.1", () => {
  const child = spawn("node", ["index.js"], {
    env: { ...process.env, MCP_TRANSPORT: "http", MCP_HTTP_PORT: String(MCP_PORT), MCP_HTTP_HOST: "127.0.0.1", MCP_AUTH_MODE: "bearer", MDNEST_TOKEN: TOKEN, MDNEST_URL: `http://127.0.0.1:${BACKEND_PORT}` },
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
