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
// Excalidraw / Marp scaffolding
// ---------------------------------------------------------------------------
// buildExcalidraw renders an Obsidian-compatible `.excalidraw.md` document. The
// whole scene lives in a fenced ```json block under "## Drawing" and every text
// element is mirrored under "## Text Elements" (searchable). Mirrors the app's
// frontend/src/excalidraw.js serializer so the file opens and round-trips
// cleanly. `elements`/`files` default to an empty (but valid) drawing.
function buildExcalidraw({ elements = [], files = {}, background = "#ffffff" } = {}) {
  const live = (Array.isArray(elements) ? elements : []).filter((el) => el && !el.isDeleted);
  const appState = {};
  if (background) appState.viewBackgroundColor = background;
  const scene = { type: "excalidraw", version: 2, source: "mdnest", elements: live, appState, files: files && typeof files === "object" ? files : {} };
  const textElements = live
    .filter((el) => el.type === "text" && el.text)
    .map((el) => `${el.text} ^${el.id}`)
    .join("\n\n");
  return [
    "---",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "---",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    textElements,
    "",
    "## Drawing",
    "```json",
    JSON.stringify(scene, null, 2),
    "```",
    "%%",
    "",
  ].join("\n");
}

// buildMarpDeck renders a Marp slide deck: YAML frontmatter carrying the
// `marp: true` marker Marp detection keys on, followed by slides separated by a
// blank-line-delimited `---`. Slides default to a single title slide.
function buildMarpDeck({ title = "Untitled deck", theme = "default", paginate = true, slides } = {}) {
  const fm = ["---", "marp: true", `theme: ${theme}`, `paginate: ${paginate ? "true" : "false"}`, "---"];
  const body = Array.isArray(slides) && slides.length
    ? slides.map((s) => String(s).trim())
    : [`# ${title}`];
  return fm.join("\n") + "\n\n" + body.join("\n\n---\n\n") + "\n";
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

server.tool(
  "list_tasks",
  "List the task-board tasks of a namespace (optionally scoped to a single note). Returns the board columns and every task with its `path`, `line` and `raw` — you need those three to move or edit a task. A task may carry status, due, priority, workload, tags, steps and notes. Tasks are plain markdown checkboxes in the notes.",
  {
    namespace: z.string().describe("Namespace name"),
    note: z.string().optional().describe("Optional note path to scope to a single note"),
  },
  async ({ namespace, note }) => {
    try {
      const q = note ? `&path=${encodeURIComponent(note)}` : "";
      const res = await api(`/api/tasks?ns=${encodeURIComponent(namespace)}${q}`);
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
  "create_task",
  "Create a task by appending it to a note (the given note, else the board's default note; the note is created if missing). Column ids come from the board returned by list_tasks.",
  {
    namespace: z.string().describe("Namespace name"),
    title: z.string().describe("Task title"),
    note: z.string().optional().describe("Target note path (defaults to the board's default note)"),
    column: z.string().optional().describe("Board column id; sets the status field / checkbox"),
    status: z.string().optional().describe("Explicit status value (usually derived from column; set only for a custom status)"),
    due: z.string().optional().describe("Due date, YYYY-MM-DD"),
    priority: z.string().optional().describe("high | medium | low"),
    workload: z.string().optional().describe("Effort estimate (free text)"),
    assignee: z.string().optional().describe("Who is responsible for the task (free text)"),
    tags: z.array(z.string()).optional().describe("Tags"),
    dependsOn: z.array(z.string()).optional().describe("Refs (from list_tasks) of tasks this one depends on"),
    blockedBy: z.array(z.string()).optional().describe("Refs of tasks blocking this one"),
    relatedTo: z.array(z.string()).optional().describe("Refs of loosely related tasks"),
    notes: z.string().optional().describe("Free-form markdown description"),
    steps: z.array(z.object({ text: z.string(), checked: z.boolean().optional() })).optional().describe("Sub-tasks"),
    defaultExpanded: z.boolean().optional().describe("Expand the card by default"),
  },
  async ({ namespace, title, note, column, status, due, priority, workload, assignee, tags, dependsOn, blockedBy, relatedTo, notes, steps, defaultExpanded }) => {
    try {
      const res = await api(`/api/tasks?ns=${encodeURIComponent(namespace)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, note, column, status, due, priority, workload, assignee, tags, dependsOn, blockedBy, relatedTo, notes, steps, defaultExpanded }),
      });
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
  "move_task",
  "Move a task to a board column (updates its status and, for the Done column, checks the box). Take `path`, `line` and `raw` from list_tasks; a 409 means the note changed — re-run list_tasks and retry.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Note path that owns the task"),
    line: z.number().describe("1-based line of the task's checkbox (from list_tasks)"),
    raw: z.string().describe("Exact source line (from list_tasks) for optimistic concurrency"),
    column: z.string().describe("Target board column id"),
  },
  async ({ namespace, path, line, raw, column }) => {
    try {
      const res = await api(
        `/api/tasks?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line, raw, toColumn: column }) }
      );
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
  "edit_task",
  "Replace a task's whole definition. Omitted fields are cleared, so pass the full desired state (read the current task with list_tasks first). Take `path`, `line` and `raw` from list_tasks; a 409 means re-list and retry.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Note path that owns the task"),
    line: z.number().describe("1-based line of the task's checkbox (from list_tasks)"),
    raw: z.string().describe("Exact source line (from list_tasks) for optimistic concurrency"),
    title: z.string().describe("Task title"),
    ref: z.string().optional().describe("Stable human id (e.g. PRJ-ab12x). Pass the task's current ref to keep it; a new one is generated if omitted."),
    column: z.string().optional().describe("Board column id"),
    status: z.string().optional().describe("Explicit status value (usually derived from column; set only for a custom status)"),
    due: z.string().optional().describe("Due date, YYYY-MM-DD"),
    priority: z.string().optional().describe("high | medium | low"),
    workload: z.string().optional().describe("Effort estimate (free text)"),
    assignee: z.string().optional().describe("Who is responsible for the task (free text)"),
    tags: z.array(z.string()).optional().describe("Tags"),
    dependsOn: z.array(z.string()).optional().describe("Refs (from list_tasks) of tasks this one depends on"),
    blockedBy: z.array(z.string()).optional().describe("Refs of tasks blocking this one"),
    relatedTo: z.array(z.string()).optional().describe("Refs of loosely related tasks"),
    notes: z.string().optional().describe("Free-form markdown description"),
    steps: z.array(z.object({ text: z.string(), checked: z.boolean().optional() })).optional().describe("Sub-tasks"),
    defaultExpanded: z.boolean().optional().describe("Expand the card by default"),
  },
  async ({ namespace, path, line, raw, title, ref, column, status, due, priority, workload, assignee, tags, dependsOn, blockedBy, relatedTo, notes, steps, defaultExpanded }) => {
    try {
      const replace = { title, ref, column, status, due, priority, workload, assignee, tags, dependsOn, blockedBy, relatedTo, notes, steps, defaultExpanded };
      const res = await api(
        `/api/tasks?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line, raw, replace }) }
      );
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
  "delete_task",
  "Delete a task (its checkbox line and indented detail block) from a note. Take `path`, `line` and `raw` from list_tasks; a 409 means the note changed — re-run list_tasks and retry.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Note path that owns the task"),
    line: z.number().describe("1-based line of the task's checkbox (from list_tasks)"),
    raw: z.string().describe("Exact source line (from list_tasks) for optimistic concurrency"),
  },
  async ({ namespace, path, line, raw }) => {
    try {
      const res = await api(
        `/api/tasks?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line, raw }) }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${text}` }], isError: true };
      }
      return { content: [{ type: "text", text: `Deleted task at ${path}:${line}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "set_task_field",
  "Set or clear a single task field without resending the whole task (lighter than edit_task). Take `path`, `line` and `raw` from list_tasks; a 409 means re-list and retry. An empty value removes the field.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Note path that owns the task"),
    line: z.number().describe("1-based line of the task's checkbox (from list_tasks)"),
    raw: z.string().describe("Exact source line (from list_tasks) for optimistic concurrency"),
    key: z.enum(["due", "priority", "workload", "assignee", "status", "tags", "depends-on", "blocked-by", "related-to"]).describe("Field to set"),
    value: z.string().describe("New value. For tags/depends-on/blocked-by/related-to pass a comma-separated list. Empty string clears the field."),
  },
  async ({ namespace, path, line, raw, key, value }) => {
    try {
      const res = await api(
        `/api/tasks?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line, raw, setField: { key, value } }) }
      );
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
  "toggle_task",
  "Check or uncheck a task (or one of its sub-steps). Checking a task while it still has open sub-steps is rejected (422). Take `path`, `line` and `raw` from list_tasks (use a step's own line/raw to toggle that step); a 409 means re-list and retry.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Note path that owns the task"),
    line: z.number().describe("1-based line of the checkbox (task or step, from list_tasks)"),
    raw: z.string().describe("Exact source line (from list_tasks) for optimistic concurrency"),
    checked: z.boolean().describe("true to check (done), false to uncheck"),
  },
  async ({ namespace, path, line, raw, checked }) => {
    try {
      const res = await api(
        `/api/tasks?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line, raw, checked }) }
      );
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
  "search_tasks",
  "Search / filter tasks. Scans a namespace (or every accessible namespace when `global` is true) and returns the tasks matching all provided filters. Filters are ANDed; omit a filter to ignore it.",
  {
    namespace: z.string().optional().describe("Namespace to search (required unless global=true)"),
    global: z.boolean().optional().describe("Search across all accessible namespaces instead of one"),
    note: z.string().optional().describe("Restrict to a single note path (namespace mode only)"),
    text: z.string().optional().describe("Case-insensitive substring matched against the task title and notes"),
    column: z.string().optional().describe("Only tasks in this board column id"),
    status: z.string().optional().describe("Only tasks with this status"),
    priority: z.string().optional().describe("Only tasks with this priority (high|medium|low)"),
    assignee: z.string().optional().describe("Case-insensitive substring matched against the assignee"),
    tags: z.array(z.string()).optional().describe("Only tasks carrying ALL of these tags"),
    checked: z.boolean().optional().describe("Filter by done (true) / not done (false)"),
    relatesTo: z.string().optional().describe("Only tasks whose depends-on/blocked-by/related-to references this ref (or title)"),
    dueBefore: z.string().optional().describe("Only tasks with a due date <= this YYYY-MM-DD (lexicographic)"),
  },
  async ({ namespace, global, note, text, column, status, priority, assignee, tags, checked, relatesTo, dueBefore }) => {
    try {
      if (!global && !namespace) {
        return { content: [{ type: "text", text: "Provide `namespace` or set `global` to true." }], isError: true };
      }
      let url;
      if (global) {
        url = `/api/tasks/all`;
      } else {
        const q = note ? `&path=${encodeURIComponent(note)}` : "";
        url = `/api/tasks?ns=${encodeURIComponent(namespace)}${q}`;
      }
      const res = await api(url);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${t}` }], isError: true };
      }
      const data = await res.json();
      const all = Array.isArray(data.tasks) ? data.tasks : [];
      const lc = (s) => (s == null ? "" : String(s)).toLowerCase();
      const wantTags = (tags || []).map(lc);
      const matches = all.filter((tk) => {
        if (text) {
          const hay = lc(tk.text) + "\n" + lc(tk.notes);
          if (!hay.includes(lc(text))) return false;
        }
        if (column && tk.column !== column) return false;
        if (status && tk.status !== status) return false;
        if (priority && lc(tk.priority) !== lc(priority)) return false;
        if (assignee && !lc(tk.assignee).includes(lc(assignee))) return false;
        if (typeof checked === "boolean" && !!tk.checked !== checked) return false;
        if (wantTags.length) {
          const have = (tk.tags || []).map(lc);
          if (!wantTags.every((w) => have.includes(w))) return false;
        }
        if (relatesTo) {
          const rel = [...(tk.dependsOn || []), ...(tk.blockedBy || []), ...(tk.relatedTo || [])].map(lc);
          if (!rel.includes(lc(relatesTo))) return false;
        }
        if (dueBefore) {
          if (!tk.due || tk.due > dueBefore) return false;
        }
        return true;
      });
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No matching tasks." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "create_excalidraw",
  "Create an Excalidraw drawing note. Scaffolds a valid, empty Obsidian-compatible `.excalidraw.md` file (openable in the app's drawing editor). The path gets a `.excalidraw.md` suffix if missing.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path for the new drawing"),
    background: z.string().optional().describe("Canvas background colour (hex, default #ffffff)"),
  },
  async ({ namespace, path, background }) => {
    try {
      let notePath = path;
      if (!/\.excalidraw(\.md)?$/i.test(notePath)) notePath += ".excalidraw.md";
      else if (/\.excalidraw$/i.test(notePath)) notePath += ".md";
      const content = buildExcalidraw({ background });
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(notePath)}`,
        { method: "POST", body: content }
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${t}` }], isError: true };
      }
      const data = await res.json().catch(() => ({}));
      return { content: [{ type: "text", text: `Created drawing ${notePath}\n${JSON.stringify(data)}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "create_marp",
  "Create a Marp slide-deck note. Scaffolds a `.md` note whose frontmatter carries `marp: true`, with slides separated by `---`. Provide `slides` (one markdown string per slide) or get a single title slide.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path for the new deck (\".md\" appended if missing)"),
    title: z.string().optional().describe("Title for the default first slide (used when `slides` is omitted)"),
    theme: z.string().optional().describe("Marp theme (default: default)"),
    paginate: z.boolean().optional().describe("Show slide numbers (default: true)"),
    slides: z.array(z.string()).optional().describe("Markdown body of each slide, in order"),
  },
  async ({ namespace, path, title, theme, paginate, slides }) => {
    try {
      let notePath = path;
      if (!notePath.endsWith(".md")) notePath += ".md";
      const content = buildMarpDeck({ title, theme, paginate: paginate !== false, slides });
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(notePath)}`,
        { method: "POST", body: content }
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${t}` }], isError: true };
      }
      const data = await res.json().catch(() => ({}));
      return { content: [{ type: "text", text: `Created deck ${notePath}\n${JSON.stringify(data)}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "add_marp_slide",
  "Append a new slide to an existing Marp deck (adds a `---` separator then the slide markdown). The note must already exist.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the Marp deck note"),
    content: z.string().describe("Markdown body of the new slide"),
  },
  async ({ namespace, path, content }) => {
    try {
      const slide = `\n\n---\n\n${String(content).trim()}\n`;
      const res = await api(
        `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}&position=bottom`,
        { method: "PATCH", body: slide }
      );
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${t}` }], isError: true };
      }
      const data = await res.json().catch(() => ({}));
      return { content: [{ type: "text", text: `Appended slide to ${path}\n${JSON.stringify(data)}` }] };
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
      // Extra origins allowed to receive an authorization code. Loopback is
      // always allowed; anything else must be listed here by the operator.
      allowedRedirectOrigins: (process.env.MCP_ALLOWED_REDIRECT_ORIGINS || "")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
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
