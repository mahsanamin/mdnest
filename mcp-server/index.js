#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer as createHttpServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual, createHash } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = process.env.MDNEST_URL || "http://localhost:8286";
const API_TOKEN = process.env.MDNEST_TOKEN;       // preferred: long-lived API token
const USERNAME = process.env.MDNEST_USER;          // fallback: username/password login
const PASSWORD = process.env.MDNEST_PASSWORD;

let token = null;

// Per-request auth context. In OAuth mode each MCP request carries the calling
// user's own mdnest JWT, which we forward to the backend so every action is
// attributed to that user. Falls back to the process-wide service token.
const authStore = new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------
async function authenticate() {
  // If an API token is provided, use it directly (no login needed)
  if (API_TOKEN) {
    token = API_TOKEN;
    return;
  }

  if (!USERNAME || !PASSWORD) {
    console.error("Set MDNEST_TOKEN (recommended) or both MDNEST_USER and MDNEST_PASSWORD");
    process.exit(1);
  }
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Authentication failed (${res.status}): ${text}`);
    process.exit(1);
  }
  const data = await res.json();
  token = data.token;
}

// ---------------------------------------------------------------------------
// Authenticated fetch with automatic 401 retry
// ---------------------------------------------------------------------------
async function api(path, options = {}, _retried = false) {
  const headers = { ...options.headers };
  // Prefer the per-request token (set in OAuth and bearer modes); fall back to
  // the process-wide service token (stdio transport).
  const reqToken = authStore.getStore()?.token || token;
  if (reqToken) {
    headers["Authorization"] = `Bearer ${reqToken}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  // Only the process-wide service token can be silently re-minted on 401.
  // A per-request user token that expired must surface the 401 to the caller.
  if (res.status === 401 && !_retried && !authStore.getStore()?.token) {
    await authenticate();
    return api(path, options, true);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------
function collectMdPaths(node, paths = []) {
  if (node.type === "file" && node.path && node.path.endsWith(".md")) {
    paths.push(node.path);
  }
  if (node.children) {
    for (const child of node.children) {
      collectMdPaths(child, paths);
    }
  }
  return paths;
}

function treeToText(node, indent = 0) {
  const prefix = "  ".repeat(indent);
  let out = "";
  if (indent === 0) {
    // root
    if (node.children) {
      for (const child of node.children) {
        out += treeToText(child, indent);
      }
    }
  } else {
    const icon = node.type === "folder" ? "[folder]" : "[file]";
    out += `${prefix}${icon} ${node.name}\n`;
    if (node.children) {
      for (const child of node.children) {
        out += treeToText(child, indent + 1);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------
// Build a fully-configured MCP server instance. Using a factory (instead of a
// module-level singleton) lets the streamable-HTTP transport spin up an
// isolated server per request, which avoids cross-client request-id
// collisions. The stdio path builds a single instance, so its behaviour is
// unchanged.
function createServer() {
  const server = new McpServer({
    name: "mdnest",
    version: "0.1.0",
  });

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  "list_namespaces",
  "List all available namespaces",
  {},
  async () => {
    try {
      const res = await api("/api/namespaces");
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_tree",
  "Get the folder/file tree for a namespace",
  { namespace: z.string().describe("Namespace name") },
  async ({ namespace }) => {
    try {
      const res = await api(`/api/tree?ns=${encodeURIComponent(namespace)}`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "read_note",
  "Read a note's content",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the note within the namespace"),
  },
  async ({ namespace, path }) => {
    try {
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const text = await res.text();
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "write_note",
  "Update an existing note's content",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the note within the namespace"),
    content: z.string().describe("New content for the note"),
  },
  async ({ namespace, path, content }) => {
    try {
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "PUT", body: content }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "create_note",
  "Create a new note (auto-appends .md if missing)",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path for the new note"),
    content: z.string().optional().describe("Initial content for the note"),
  },
  async ({ namespace, path, content }) => {
    try {
      let notePath = path;
      if (!notePath.endsWith(".md")) {
        notePath += ".md";
      }
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(notePath)}`,
        { method: "POST", body: content || "" }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "append_note",
  "Append text to the end of a note. Creates the note if it doesn't exist.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the note within the namespace"),
    content: z.string().describe("Text to append"),
  },
  async ({ namespace, path, content }) => {
    try {
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}&position=bottom`,
        { method: "PATCH", body: content }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "prepend_note",
  "Prepend text to the top of a note. Creates the note if it doesn't exist.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the note within the namespace"),
    content: z.string().describe("Text to prepend"),
  },
  async ({ namespace, path, content }) => {
    try {
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}&position=top`,
        { method: "PATCH", body: content }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "create_folder",
  "Create a new folder",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path for the new folder"),
  },
  async ({ namespace, path }) => {
    try {
      const res = await api(
        `/api/folder?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "delete_item",
  "Delete a file or folder",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the item to delete"),
  },
  async ({ namespace, path }) => {
    try {
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "move_item",
  "Move a file or folder to a new location",
  {
    namespace: z.string().describe("Namespace name"),
    from: z.string().describe("Source path"),
    to: z.string().describe("Destination path"),
  },
  async ({ namespace, from, to }) => {
    try {
      const res = await api(
        `/api/move?ns=${encodeURIComponent(namespace)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { method: "POST" }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      const data = await res.json();
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "search_notes",
  "Search note contents for a query string (case-insensitive). Returns up to 20 matching paths with snippets.",
  {
    namespace: z.string().describe("Namespace name"),
    query: z.string().describe("Search query"),
  },
  async ({ namespace, query }) => {
    try {
      // Get the tree
      const treeRes = await api(`/api/tree?ns=${encodeURIComponent(namespace)}`);
      if (!treeRes.ok) {
        const text = await treeRes.text().catch(() => "");
        return { content: [{ type: "text", text: `Error fetching tree ${treeRes.status}: ${text}` }], isError: true };
      }
      const tree = await treeRes.json();
      const mdPaths = collectMdPaths(tree);

      const results = [];
      const lowerQuery = query.toLowerCase();

      for (const mdPath of mdPaths) {
        if (results.length >= 20) break;
        try {
          const noteRes = await api(
            `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(mdPath)}`
          );
          if (!noteRes.ok) continue;
          const content = await noteRes.text();
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              const snippet = lines[i].trim().substring(0, 200);
              results.push({ path: mdPath, line: i + 1, snippet });
              break; // one match per file
            }
          }
        } catch {
          // skip files that fail to read
        }
      }

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No matches found." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

server.resource(
  "namespace_tree",
  "notes://{namespace}",
  async (uri, { namespace }) => {
    try {
      const res = await api(`/api/tree?ns=${encodeURIComponent(namespace)}`);
      if (!res.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Error ${res.status}` }] };
      }
      const tree = await res.json();
      const text = treeToText(tree);
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
    } catch (err) {
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Error: ${err.message}` }] };
    }
  }
);

server.resource(
  "note_content",
  "notes://{namespace}/{+path}",
  async (uri, { namespace, path }) => {
    try {
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`
      );
      if (!res.ok) {
        return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Error ${res.status}` }] };
      }
      const text = await res.text();
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
    } catch (err) {
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: `Error: ${err.message}` }] };
    }
  }
);

  return server;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

// Default: stdio (unchanged behaviour). Opt in to network mode by setting
// MCP_TRANSPORT=http (a.k.a. "streamable-http").
async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Streamable-HTTP transport, stateless: each POST is served by a fresh
// server + transport pair. GET (server-initiated SSE streams) and DELETE
// (session teardown) are unused in stateless mode and return 405.
async function startHttp() {
  const port = parseInt(process.env.MCP_HTTP_PORT || "3000", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const mcpPath = process.env.MCP_HTTP_PATH || "/mcp";

  // Loaded lazily so a stdio spawn never parses the HTTP/OAuth modules it will
  // never run: MCP_TRANSPORT unset means stdio, and none of this initialises.
  const { StreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");

  // Authentication mode for the HTTP endpoint. Mutually exclusive, selected by
  // MCP_AUTH_MODE:
  //   bearer — clients present a static mdnest API token (service / gateway
  //            integration, e.g. an MCP gateway federating this server). The
  //            presented token is constant-time compared against MDNEST_TOKEN
  //            and forwarded to the backend.
  //   oauth  — per-user delegation via OAuth 2.1 authorization-code + PKCE; each
  //            request carries the calling user's own mdnest JWT, forwarded to
  //            the backend so every action is attributed to that user.
  const authMode = (process.env.MCP_AUTH_MODE || "bearer").toLowerCase();
  if (authMode !== "bearer" && authMode !== "oauth") {
    console.error(`MCP_AUTH_MODE must be "bearer" or "oauth" (got "${authMode}")`);
    process.exit(1);
  }

  let oauth = null;
  if (authMode === "oauth") {
    const publicUrl = process.env.MCP_PUBLIC_URL;
    const secret = process.env.MCP_OAUTH_SECRET;
    const ssoAuthorizeUrl = process.env.MCP_SSO_AUTHORIZE_URL;
    if (!publicUrl || !secret || !ssoAuthorizeUrl) {
      console.error("MCP_AUTH_MODE=oauth requires MCP_PUBLIC_URL, MCP_OAUTH_SECRET and MCP_SSO_AUTHORIZE_URL");
      process.exit(1);
    }
    const { buildOAuth } = await import("./oauth.js");
    oauth = buildOAuth({
      publicUrl,
      mcpPath,
      secret,
      ssoAuthorizeUrl,
      validateUrl: BASE_URL,
      secureCookie: publicUrl.startsWith("https://"),
    });
  } else if (!API_TOKEN) {
    console.error("MCP_AUTH_MODE=bearer requires MDNEST_TOKEN (a valid mdnest API token)");
    process.exit(1);
  }

  const jsonError = (id, code, message) =>
    JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: id ?? null });

  // bearer mode: extract the presented bearer and constant-time compare it
  // against the configured static token.
  const bearerFromReq = (req) => {
    const h = req.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(h);
    return m ? m[1].trim() : null;
  };
  const tokenMatches = (presented) => {
    if (!presented || !API_TOKEN) return false;
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(API_TOKEN).digest();
    return timingSafeEqual(a, b);
  };

  const handlePost = async (req, res, userToken) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(jsonError(null, -32700, "Parse error"));
      return;
    }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    // Run the request inside an auth context so api() forwards the caller's
    // own token to the backend. In OAuth mode this is the user's JWT; in bearer
    // mode it is the configured static token. For stdio userToken is undefined
    // and api() falls back to the process-wide token.
    await authStore.run({ token: userToken }, () => transport.handleRequest(req, res, body));
  };

  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // OAuth 2.1 discovery + authorization endpoints (oauth mode only).
    if (oauth && oauth.handle(req, res, url)) {
      return;
    }

    if (url.pathname !== mcpPath) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(jsonError(null, -32601, "Not found"));
      return;
    }

    if (req.method === "POST") {
      let userToken;
      if (oauth) {
        userToken = oauth.bearer(req);
        if (!userToken) {
          oauth.challenge(res, jsonError(null, -32001, "Authentication required"));
          return;
        }
      } else {
        // bearer mode: require the configured static mdnest API token.
        const presented = bearerFromReq(req);
        if (!tokenMatches(presented)) {
          res.writeHead(401, {
            "Content-Type": "application/json",
            "WWW-Authenticate": "Bearer",
            "Cache-Control": "no-store",
          });
          res.end(jsonError(null, -32001, "Authentication required"));
          return;
        }
        userToken = API_TOKEN;
      }
      handlePost(req, res, userToken).catch((err) => {
        console.error("MCP request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(jsonError(null, -32603, "Internal error"));
        }
      });
      return;
    }

    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(jsonError(null, -32000, "Method not allowed (stateless streamable-http accepts POST only)"));
  });

  httpServer.listen(port, host, () => {
    console.error(`mdnest MCP server (streamable-http) listening on http://${host}:${port}${mcpPath} [${authMode}]`);
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  const mode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
  const httpMode = mode === "http" || mode === "streamable-http";
  const oauthMode = httpMode && (process.env.MCP_AUTH_MODE || "bearer").toLowerCase() === "oauth";
  // In OAuth mode the backend credential is supplied per request by each user,
  // so no process-wide service token is needed. Otherwise (bearer / stdio)
  // authenticate now with the service token.
  if (!oauthMode) {
    await authenticate();
  }
  if (httpMode) {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
