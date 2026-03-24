#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = process.env.MDNEST_URL || "http://localhost:8286";
const API_TOKEN = process.env.MDNEST_TOKEN;       // preferred: long-lived API token
const USERNAME = process.env.MDNEST_USER;          // fallback: username/password login
const PASSWORD = process.env.MDNEST_PASSWORD;

let token = null;

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
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (res.status === 401 && !_retried) {
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function main() {
  await authenticate();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
