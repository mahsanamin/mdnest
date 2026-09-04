#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer as createHttpServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { timingSafeEqual, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
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
// Feature flags (mirror the backend so the tool surface matches the app)
// ---------------------------------------------------------------------------
// The gated features (task board, Marp, Excalidraw) are read from the backend's
// unauthenticated GET /api/config once at startup. Their tools are only
// registered when the backend has them enabled — an operator running notes-only
// mdnest sees no task/drawing/slide tools. If /api/config can't be read we stay
// permissive (expose everything) rather than hide a working feature.
const features = { taskBoard: true, marp: true, excalidraw: true };
async function loadFeatures() {
  try {
    const res = await fetch(`${BASE_URL}/api/config`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const cfg = await res.json();
    features.taskBoard = !!cfg.taskBoard;
    features.marp = !!cfg.marp;
    features.excalidraw = !!cfg.excalidraw;
  } catch (err) {
    console.error(`Could not read /api/config (${err.message}); exposing all tools.`);
    features.taskBoard = features.marp = features.excalidraw = true;
  }
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
export function buildExcalidraw({ elements = [], files = {}, background = "#ffffff" } = {}) {
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
export function buildMarpDeck({ title = "Untitled deck", theme = "default", paginate = true, slides } = {}) {
  const fm = ["---", "marp: true", `theme: ${theme}`, `paginate: ${paginate ? "true" : "false"}`, "---"];
  const body = Array.isArray(slides) && slides.length
    ? slides.map((s) => String(s).trim())
    : [`# ${title}`];
  return fm.join("\n") + "\n\n" + body.join("\n\n---\n\n") + "\n";
}

// splitMarp separates a Marp note into its leading YAML frontmatter and an
// array of slide bodies. Slide boundaries are `---` lines preceded by a blank
// line and outside fenced code blocks — the same rule the app's slide preview
// uses (frontend/src/marp.js) — so an agent edits the same slides the deck
// shows.
export function splitMarp(content) {
  const lines = (content == null ? "" : String(content)).split("\n");
  let frontmatter = "";
  let i = 0;
  if (lines.length && /^---\s*$/.test(lines[0])) {
    let j = 1;
    while (j < lines.length && !/^---\s*$/.test(lines[j])) j++;
    if (j < lines.length) {
      frontmatter = lines.slice(0, j + 1).join("\n");
      i = j + 1;
    }
  }
  const body = lines.slice(i);
  const slides = [];
  let cur = [];
  let inFence = false;
  let prevBlank = true;
  for (const line of body) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; cur.push(line); prevBlank = false; continue; }
    if (!inFence && prevBlank && /^---\s*$/.test(line)) {
      slides.push(cur);
      cur = [];
      prevBlank = true;
      continue; // the separator itself belongs to no slide
    }
    cur.push(line);
    prevBlank = line.trim() === "";
  }
  slides.push(cur);
  return { frontmatter, slides: slides.map((arr) => arr.join("\n").replace(/^\n+/, "").replace(/\n+$/, "")) };
}

// joinMarp rebuilds a Marp note from its frontmatter and slide bodies.
export function joinMarp(frontmatter, slides) {
  const body = (slides || []).map((s) => String(s).trim()).join("\n\n---\n\n");
  return (frontmatter ? frontmatter + "\n\n" : "") + body + "\n";
}

// --- Excalidraw scene compiler -------------------------------------------
// An Excalidraw scene is a flat list of elements with a lot of required
// bookkeeping fields (seed, versionNonce, bindings, ...). Authoring that by
// hand is error-prone for an agent, so `draw_excalidraw` takes a high-level
// diagram (nodes + edges) and compiles it here into a valid scene: shapes with
// centred bound labels, arrows bound to their endpoints, and the reciprocal
// `boundElements` back-references Excalidraw needs to keep them connected.
const exId = () => {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 21; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
};
const randInt = () => Math.floor(Math.random() * 2 ** 31);

function baseElement(p) {
  const el = {
    id: p.id,
    type: p.type,
    x: p.x, y: p.y, width: p.width, height: p.height,
    angle: 0,
    strokeColor: p.strokeColor || "#1e1e1e",
    backgroundColor: p.backgroundColor || "transparent",
    fillStyle: p.fillStyle || "solid",
    strokeWidth: 2,
    strokeStyle: p.strokeStyle || "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: p.roundness ?? null,
    seed: randInt(),
    version: 1,
    versionNonce: randInt(),
    isDeleted: false,
    boundElements: p.boundElements ?? null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
  return Object.assign(el, p.extra || {});
}

const SHAPES = ["rectangle", "ellipse", "diamond"];

// compileDiagram turns { nodes, edges } into Excalidraw elements. When
// existingElements is given (append mode) their shapes can be edge endpoints
// too and their boundElements are updated in place; the returned list is the
// full scene.
export function compileDiagram({ nodes = [], edges = [], existingElements = [] }) {
  const out = existingElements.slice();
  const byId = new Map();
  const register = (key, el) => {
    if (el.boundElements == null) el.boundElements = [];
    byId.set(String(key), { el, cx: el.x + el.width / 2, cy: el.y + el.height / 2 });
  };
  for (const el of existingElements) {
    if (SHAPES.includes(el.type)) register(el.id, el);
  }
  const cols = 3;
  nodes.forEach((n, i) => {
    const w = Number(n.width) || 160;
    const h = Number(n.height) || 80;
    const x = n.x != null ? Number(n.x) : 120 + (i % cols) * (w + 90);
    const y = n.y != null ? Number(n.y) : 120 + Math.floor(i / cols) * (h + 90);
    const shape = SHAPES.includes(n.shape) ? n.shape : "rectangle";
    const id = exId();
    const shapeEl = baseElement({
      id, type: shape, x, y, width: w, height: h,
      strokeColor: n.strokeColor,
      backgroundColor: n.backgroundColor,
      fillStyle: n.fillStyle,
      roundness: shape === "rectangle" ? { type: 3 } : null,
      boundElements: [],
    });
    out.push(shapeEl);
    register(n.id, shapeEl);
    if (n.text) {
      const textId = exId();
      out.push(baseElement({
        id: textId, type: "text",
        x: x + 8, y: y + h / 2 - 12, width: Math.max(20, w - 16), height: 25,
        strokeColor: n.strokeColor,
        extra: { text: String(n.text), fontSize: 20, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: id, originalText: String(n.text), lineHeight: 1.25, autoResize: true },
      }));
      shapeEl.boundElements.push({ id: textId, type: "text" });
    }
  });
  edges.forEach((e) => {
    const a = byId.get(String(e.from));
    const b = byId.get(String(e.to));
    if (!a || !b) return; // endpoint not found — skip rather than emit a dangling arrow
    const id = exId();
    const arrowEl = baseElement({
      id, type: "arrow",
      x: a.cx, y: a.cy, width: b.cx - a.cx, height: b.cy - a.cy,
      strokeStyle: e.dashed ? "dashed" : "solid",
      boundElements: e.text ? [] : null,
      extra: {
        points: [[0, 0], [b.cx - a.cx, b.cy - a.cy]],
        lastCommittedPoint: null,
        startBinding: { elementId: a.el.id, focus: 0, gap: 4 },
        endBinding: { elementId: b.el.id, focus: 0, gap: 4 },
        startArrowhead: null,
        endArrowhead: e.arrowhead === false ? null : "arrow",
        elbowed: false,
      },
    });
    out.push(arrowEl);
    a.el.boundElements.push({ id, type: "arrow" });
    b.el.boundElements.push({ id, type: "arrow" });
    if (e.text) {
      const textId = exId();
      const mx = a.cx + (b.cx - a.cx) / 2;
      const my = a.cy + (b.cy - a.cy) / 2;
      out.push(baseElement({
        id: textId, type: "text",
        x: mx - 40, y: my - 12, width: 80, height: 25,
        extra: { text: String(e.text), fontSize: 16, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: id, originalText: String(e.text), lineHeight: 1.25, autoResize: true },
      }));
      arrowEl.boundElements.push({ id: textId, type: "text" });
    }
  });
  return out;
}

// sceneToDiagram parses a `.excalidraw.md` note back into the high-level
// { nodes, edges } shape so an agent can inspect a drawing before editing it.
export function sceneToDiagram(content) {
  const text = content || "";
  const fence = text.match(/```json\s*\n([\s\S]*?)\n```/);
  let raw = fence ? fence[1] : (text.trim().startsWith("{") ? text : null);
  if (!raw) return { nodes: [], edges: [], nodeCount: 0, edgeCount: 0 };
  let scene;
  try { scene = JSON.parse(raw); } catch { return { nodes: [], edges: [], nodeCount: 0, edgeCount: 0, error: "unparseable scene" }; }
  const els = (Array.isArray(scene.elements) ? scene.elements : []).filter((el) => el && !el.isDeleted);
  const labelOf = {};
  for (const el of els) if (el.type === "text" && el.containerId) labelOf[el.containerId] = el.text;
  const nodes = els.filter((el) => SHAPES.includes(el.type)).map((el) => ({
    id: el.id, shape: el.type, x: el.x, y: el.y, width: el.width, height: el.height,
    ...(labelOf[el.id] ? { text: labelOf[el.id] } : {}),
  }));
  const edges = els.filter((el) => el.type === "arrow" || el.type === "line").map((el) => ({
    id: el.id,
    from: el.startBinding?.elementId || null,
    to: el.endBinding?.elementId || null,
    ...(labelOf[el.id] ? { text: labelOf[el.id] } : {}),
  }));
  return { background: scene.appState?.viewBackgroundColor, nodeCount: nodes.length, edgeCount: edges.length, nodes, edges };
}

// --- Excalidraw element-level edits --------------------------------------
// parseScene extracts the full (unsimplified) element list + files + background
// from a `.excalidraw.md` note, so element-level edits keep every Excalidraw
// bookkeeping field intact.
export function parseScene(content) {
  const fence = (content || "").match(/```json\s*\n([\s\S]*?)\n```/);
  if (!fence) return { elements: [], files: {}, background: undefined };
  try {
    const sc = JSON.parse(fence[1]);
    return {
      elements: (Array.isArray(sc.elements) ? sc.elements : []).filter((el) => el && !el.isDeleted),
      files: sc.files && typeof sc.files === "object" ? sc.files : {},
      background: sc.appState?.viewBackgroundColor,
    };
  } catch {
    return { elements: [], files: {}, background: undefined };
  }
}

// reflowScene keeps a scene consistent after an edit: bound arrows are redrawn
// from their endpoints' centres and bound labels re-centred on their container.
function reflowScene(elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const center = (el) => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
  for (const el of elements) {
    if (el.type === "arrow" && el.startBinding && el.endBinding) {
      const a = byId.get(el.startBinding.elementId);
      const b = byId.get(el.endBinding.elementId);
      if (a && b) {
        const ac = center(a), bc = center(b);
        el.x = ac.x; el.y = ac.y;
        el.width = bc.x - ac.x; el.height = bc.y - ac.y;
        el.points = [[0, 0], [bc.x - ac.x, bc.y - ac.y]];
      }
    }
  }
  for (const el of elements) {
    if (el.type === "text" && el.containerId) {
      const c = byId.get(el.containerId);
      if (!c) continue;
      if (SHAPES.includes(c.type)) { el.x = c.x + 8; el.y = c.y + c.height / 2 - 12; el.width = Math.max(20, c.width - 16); }
      else if (c.type === "arrow") { el.x = c.x + c.width / 2 - (el.width || 80) / 2; el.y = c.y + c.height / 2 - 12; }
    }
  }
  return elements;
}

// setBoundLabel creates, updates, or (text === "") removes the text label bound
// to a container element, keeping the reciprocal boundElements ref in sync.
function setBoundLabel(elements, container, text) {
  const label = elements.find((e) => e.type === "text" && e.containerId === container.id);
  if (text === "") {
    if (!label) return elements;
    if (Array.isArray(container.boundElements)) container.boundElements = container.boundElements.filter((b) => b.id !== label.id);
    return elements.filter((e) => e.id !== label.id);
  }
  if (label) {
    label.text = String(text); label.originalText = String(text);
    label.version = (label.version || 1) + 1; label.versionNonce = randInt(); label.updated = Date.now();
    return elements;
  }
  const tid = exId();
  const isShape = SHAPES.includes(container.type);
  const t = baseElement({
    id: tid, type: "text",
    x: container.x + 8, y: container.y + (container.height || 0) / 2 - 12,
    width: Math.max(20, (container.width || 80) - 16), height: 25,
    extra: { text: String(text), fontSize: isShape ? 20 : 16, fontFamily: 1, textAlign: "center", verticalAlign: "middle", containerId: container.id, originalText: String(text), lineHeight: 1.25, autoResize: true },
  });
  if (!Array.isArray(container.boundElements)) container.boundElements = [];
  container.boundElements.push({ id: tid, type: "text" });
  return elements.concat([t]);
}

// editExcalidrawNode updates a single shape (geometry, colours, shape kind,
// label) by element id.
export function editExcalidrawNode(elements, id, props = {}) {
  const el = elements.find((e) => e.id === id && SHAPES.includes(e.type));
  if (!el) return { error: `node ${id} not found` };
  if (props.x != null) el.x = Number(props.x);
  if (props.y != null) el.y = Number(props.y);
  if (props.width != null) el.width = Number(props.width);
  if (props.height != null) el.height = Number(props.height);
  if (props.strokeColor) el.strokeColor = props.strokeColor;
  if (props.backgroundColor) el.backgroundColor = props.backgroundColor;
  if (props.fillStyle) el.fillStyle = props.fillStyle;
  if (props.shape && SHAPES.includes(props.shape)) { el.type = props.shape; el.roundness = props.shape === "rectangle" ? { type: 3 } : null; }
  el.version = (el.version || 1) + 1; el.versionNonce = randInt(); el.updated = Date.now();
  let out = elements;
  if (props.text != null) out = setBoundLabel(out, el, String(props.text));
  reflowScene(out);
  return { elements: out };
}

// editExcalidrawEdge updates a single arrow (label, dashed, arrowhead, colour).
export function editExcalidrawEdge(elements, id, props = {}) {
  const el = elements.find((e) => e.id === id && (e.type === "arrow" || e.type === "line"));
  if (!el) return { error: `edge ${id} not found` };
  if (props.dashed != null) el.strokeStyle = props.dashed ? "dashed" : "solid";
  if (props.arrowhead != null) el.endArrowhead = props.arrowhead ? "arrow" : null;
  if (props.strokeColor) el.strokeColor = props.strokeColor;
  el.version = (el.version || 1) + 1; el.versionNonce = randInt(); el.updated = Date.now();
  let out = elements;
  if (props.text != null) out = setBoundLabel(out, el, String(props.text));
  reflowScene(out);
  return { elements: out };
}

// deleteExcalidrawElement removes an element by id and everything that only
// existed because of it: a shape takes its label and every connected arrow (and
// their labels); an arrow takes its label.
export function deleteExcalidrawElement(elements, id) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const target = byId.get(id);
  if (!target) return { error: `element ${id} not found` };
  const remove = new Set([id]);
  if (SHAPES.includes(target.type)) {
    for (const el of elements) {
      if (el.type === "arrow" && (el.startBinding?.elementId === id || el.endBinding?.elementId === id)) remove.add(el.id);
      if (el.type === "text" && el.containerId === id) remove.add(el.id);
    }
  } else {
    for (const el of elements) if (el.type === "text" && el.containerId === id) remove.add(el.id);
  }
  // Labels bound to any arrow we are removing go too.
  for (const el of elements) if (el.type === "text" && el.containerId && remove.has(el.containerId)) remove.add(el.id);
  const kept = elements.filter((e) => !remove.has(e.id));
  for (const el of kept) if (Array.isArray(el.boundElements)) el.boundElements = el.boundElements.filter((b) => !remove.has(b.id));
  reflowScene(kept);
  return { elements: kept, removed: remove.size };
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
  "edit_note",
  "Replace an exact string inside a note, leaving the rest of the file untouched. Fails if old_string is not found, or if it occurs more than once and replace_all is not set. The write is rejected if the note changed after this tool read it, so a concurrent edit is never silently overwritten.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the note within the namespace"),
    old_string: z.string().describe("Exact text to replace, including whitespace. Add surrounding context to make it unique."),
    new_string: z.string().describe("Replacement text. Pass an empty string to delete old_string."),
    replace_all: z.boolean().optional().describe("Replace every occurrence instead of failing when old_string is not unique"),
  },
  async ({ namespace, path, old_string, new_string, replace_all }) => {
    try {
      if (old_string === "") {
        return { content: [{ type: "text", text: "Error: old_string must not be empty; use write_note to replace the whole note" }], isError: true };
      }
      if (old_string === new_string) {
        return { content: [{ type: "text", text: "Error: old_string and new_string are identical; nothing to edit" }], isError: true };
      }

      const query = `ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`;
      const readRes = await api(`/api/note?${query}`);
      if (!readRes.ok) {
        const text = await readRes.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${readRes.status}: ${text}` }], isError: true };
      }
      const before = await readRes.text();
      // The note's ETag, so the PUT below can refuse to clobber a concurrent save.
      const etag = readRes.headers.get("etag");

      const parts = before.split(old_string);
      const matches = parts.length - 1;
      if (matches === 0) {
        return { content: [{ type: "text", text: "Error: old_string not found in the note" }], isError: true };
      }
      if (matches > 1 && !replace_all) {
        return { content: [{ type: "text", text: `Error: old_string occurs ${matches} times; add surrounding context to make it unique, or set replace_all` }], isError: true };
      }

      let after;
      if (replace_all) {
        // join() splices the replacement in literally — unlike String.replace,
        // which would expand $&/$1 patterns inside new_string.
        after = parts.join(new_string);
      } else {
        const at = before.indexOf(old_string);
        after = before.slice(0, at) + new_string + before.slice(at + old_string.length);
      }

      const writeRes = await api(`/api/note?${query}`, {
        method: "PUT",
        body: after,
        headers: etag ? { "If-Match": etag } : {},
      });
      if (!writeRes.ok) {
        const text = await writeRes.text().catch(() => "");
        const hint = text.includes("modified by another user") ? " -- read the note again and redo the edit on the current content" : "";
        return { content: [{ type: "text", text: `Error ${writeRes.status}: ${text}${hint}` }], isError: true };
      }
      const data = await writeRes.json().catch(() => ({}));
      return { content: [{ type: "text", text: JSON.stringify({ ...data, replacements: replace_all ? matches : 1 }) }] };
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

if (features.taskBoard) server.tool(
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

if (features.taskBoard) server.tool(
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

if (features.taskBoard) server.tool(
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

if (features.taskBoard) server.tool(
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

if (features.taskBoard) server.tool(
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

if (features.taskBoard) server.tool(
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

if (features.taskBoard) server.tool(
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

if (features.taskBoard) server.tool(
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

if (features.excalidraw) server.tool(
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

if (features.excalidraw) server.tool(
  "draw_excalidraw",
  "Author or edit an Excalidraw diagram from a high-level spec: `nodes` (labelled shapes) and `edges` (arrows between nodes). Compiles to a valid drawing with bound labels and connected arrows. `mode:\"replace\"` (default) rewrites the whole drawing from your spec; `mode:\"append\"` adds to the existing one — in append mode an edge's `from`/`to` may reference a new node id OR an existing element id (see read_excalidraw). Omit x/y to auto-layout on a grid. The path gets a `.excalidraw.md` suffix if missing.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the drawing note"),
    nodes: z.array(z.object({
      id: z.string().describe("Logical id you reference from edges"),
      text: z.string().optional().describe("Label shown centred in the shape"),
      shape: z.enum(["rectangle", "ellipse", "diamond"]).optional().describe("Shape (default rectangle)"),
      x: z.number().optional().describe("Top-left x (auto-laid-out if omitted)"),
      y: z.number().optional().describe("Top-left y (auto-laid-out if omitted)"),
      width: z.number().optional().describe("Width (default 160)"),
      height: z.number().optional().describe("Height (default 80)"),
      strokeColor: z.string().optional().describe("Stroke colour (hex, default #1e1e1e)"),
      backgroundColor: z.string().optional().describe("Fill colour (hex, default transparent)"),
      fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).optional().describe("Fill style (default solid)"),
    })).optional().describe("Nodes (labelled shapes)"),
    edges: z.array(z.object({
      from: z.string().describe("Source node id (or existing element id in append mode)"),
      to: z.string().describe("Target node id (or existing element id in append mode)"),
      text: z.string().optional().describe("Arrow label"),
      dashed: z.boolean().optional().describe("Dashed line"),
      arrowhead: z.boolean().optional().describe("Draw an arrowhead at the target end (default true)"),
    })).optional().describe("Edges (arrows between nodes)"),
    mode: z.enum(["replace", "append"]).optional().describe("replace (default) rewrites the drawing; append adds to it"),
    background: z.string().optional().describe("Canvas background colour (hex)"),
  },
  async ({ namespace, path, nodes, edges, mode, background }) => {
    try {
      let notePath = path;
      if (!/\.excalidraw(\.md)?$/i.test(notePath)) notePath += ".excalidraw.md";
      else if (/\.excalidraw$/i.test(notePath)) notePath += ".md";
      const noteUrl = `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(notePath)}`;

      let existingElements = [];
      let existingFiles = {};
      let bg = background;
      let exists = false;
      const getRes = await api(noteUrl);
      if (getRes.ok) {
        exists = true;
        const cur = await getRes.text();
        const fence = cur.match(/```json\s*\n([\s\S]*?)\n```/);
        if (fence) {
          try {
            const sc = JSON.parse(fence[1]);
            if (Array.isArray(sc.elements)) existingElements = sc.elements.filter((el) => el && !el.isDeleted);
            if (sc.files && typeof sc.files === "object") existingFiles = sc.files;
            if (!bg && sc.appState?.viewBackgroundColor) bg = sc.appState.viewBackgroundColor;
          } catch { /* fresh/empty drawing */ }
        }
      }

      const seed = mode === "append" ? existingElements : [];
      const elements = compileDiagram({ nodes: nodes || [], edges: edges || [], existingElements: seed });
      const content = buildExcalidraw({ elements, files: mode === "append" ? existingFiles : {}, background: bg || "#ffffff" });
      const res = await api(noteUrl, { method: exists ? "PUT" : "POST", body: content });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${t}` }], isError: true };
      }
      const summary = sceneToDiagram(content);
      return { content: [{ type: "text", text: `${mode === "append" ? "Updated" : "Wrote"} drawing ${notePath} \u2014 ${summary.nodeCount} nodes, ${summary.edgeCount} edges` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

if (features.excalidraw) server.tool(
  "read_excalidraw",
  "Read an Excalidraw drawing as a high-level diagram: its nodes (shape, label, position, and stable element id) and edges (from/to element ids, label). Use the returned element ids to target existing shapes when calling draw_excalidraw in append mode.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the drawing note"),
  },
  async ({ namespace, path }) => {
    try {
      const res = await api(`/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { content: [{ type: "text", text: `Error ${res.status}: ${t}` }], isError: true };
      }
      const diagram = sceneToDiagram(await res.text());
      return { content: [{ type: "text", text: JSON.stringify(diagram, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// Shared read-modify-write for the element-level Excalidraw edit tools.
async function loadScene(namespace, path) {
  const url = `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`;
  const res = await api(url);
  if (!res.ok) return { error: `Error ${res.status}: ${await res.text().catch(() => "")}` };
  return { url, ...parseScene(await res.text()) };
}
async function saveScene(url, elements, files, background) {
  const res = await api(url, { method: "PUT", body: buildExcalidraw({ elements, files, background: background || "#ffffff" }) });
  if (!res.ok) return `Error ${res.status}: ${await res.text().catch(() => "")}`;
  return null;
}
const exEditErr = (text) => ({ content: [{ type: "text", text }], isError: true });

if (features.excalidraw) server.tool(
  "edit_excalidraw_node",
  "Edit one shape of a drawing by its element id (from read_excalidraw), without redrawing the rest: change its label, shape kind, position, size or colours. Connected arrows and the label re-flow automatically. Set `text` to \"\" to remove the label.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the drawing note"),
    id: z.string().describe("Element id of the shape (from read_excalidraw)"),
    text: z.string().optional().describe("New label (\"\" removes it)"),
    shape: z.enum(["rectangle", "ellipse", "diamond"]).optional().describe("Change the shape kind"),
    x: z.number().optional(), y: z.number().optional(),
    width: z.number().optional(), height: z.number().optional(),
    strokeColor: z.string().optional().describe("Stroke colour (hex)"),
    backgroundColor: z.string().optional().describe("Fill colour (hex)"),
    fillStyle: z.enum(["solid", "hachure", "cross-hatch"]).optional(),
  },
  async ({ namespace, path, id, ...props }) => {
    try {
      const s = await loadScene(namespace, path);
      if (s.error) return exEditErr(s.error);
      const r = editExcalidrawNode(s.elements, id, props);
      if (r.error) return exEditErr(r.error);
      const err = await saveScene(s.url, r.elements, s.files, s.background);
      if (err) return exEditErr(err);
      return { content: [{ type: "text", text: `Updated node ${id} in ${path}` }] };
    } catch (err) {
      return exEditErr(`Error: ${err.message}`);
    }
  }
);

if (features.excalidraw) server.tool(
  "edit_excalidraw_edge",
  "Edit one arrow of a drawing by its element id (from read_excalidraw): change its label, dashed style, arrowhead or colour. Set `text` to \"\" to remove the label.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the drawing note"),
    id: z.string().describe("Element id of the arrow (from read_excalidraw)"),
    text: z.string().optional().describe("New label (\"\" removes it)"),
    dashed: z.boolean().optional().describe("Dashed vs solid line"),
    arrowhead: z.boolean().optional().describe("Draw an arrowhead at the target end"),
    strokeColor: z.string().optional().describe("Stroke colour (hex)"),
  },
  async ({ namespace, path, id, ...props }) => {
    try {
      const s = await loadScene(namespace, path);
      if (s.error) return exEditErr(s.error);
      const r = editExcalidrawEdge(s.elements, id, props);
      if (r.error) return exEditErr(r.error);
      const err = await saveScene(s.url, r.elements, s.files, s.background);
      if (err) return exEditErr(err);
      return { content: [{ type: "text", text: `Updated edge ${id} in ${path}` }] };
    } catch (err) {
      return exEditErr(`Error: ${err.message}`);
    }
  }
);

if (features.excalidraw) server.tool(
  "delete_excalidraw_element",
  "Delete one element of a drawing by its element id (from read_excalidraw). Deleting a shape also removes its label and every arrow connected to it; deleting an arrow removes its label.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the drawing note"),
    id: z.string().describe("Element id to delete (from read_excalidraw)"),
  },
  async ({ namespace, path, id }) => {
    try {
      const s = await loadScene(namespace, path);
      if (s.error) return exEditErr(s.error);
      const r = deleteExcalidrawElement(s.elements, id);
      if (r.error) return exEditErr(r.error);
      const err = await saveScene(s.url, r.elements, s.files, s.background);
      if (err) return exEditErr(err);
      return { content: [{ type: "text", text: `Deleted ${r.removed} element${r.removed === 1 ? "" : "s"} (${id} + dependents) in ${path}` }] };
    } catch (err) {
      return exEditErr(`Error: ${err.message}`);
    }
  }
);

if (features.marp) server.tool(
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

// Shared read-modify-write for the per-slide Marp CRUD tools: load the note,
// split it into { frontmatter, slides }; callers mutate slides then saveMarp.
async function loadMarp(namespace, path) {
  const url = `/api/note?ns=${encodeURIComponent(namespace)}&path=${encodeURIComponent(path)}`;
  const res = await api(url);
  if (!res.ok) return { error: `Error ${res.status}: ${await res.text().catch(() => "")}` };
  const content = await res.text();
  return { url, ...splitMarp(content) };
}
async function saveMarp(url, frontmatter, slides) {
  const res = await api(url, { method: "PUT", body: joinMarp(frontmatter, slides) });
  if (!res.ok) return `Error ${res.status}: ${await res.text().catch(() => "")}`;
  return null;
}
const marpErr = (text) => ({ content: [{ type: "text", text }], isError: true });
const marpBadIndex = (index, count) => marpErr(`Slide ${index} is out of range (deck has ${count} slide${count === 1 ? "" : "s"}).`);

if (features.marp) server.tool(
  "add_marp_slide",
  "Add a slide to a Marp deck. Appends at the end by default, or inserts before the 1-based `index`. The note must already exist.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the Marp deck note"),
    content: z.string().describe("Markdown body of the new slide"),
    index: z.number().optional().describe("1-based position to insert before (default: append at the end)"),
  },
  async ({ namespace, path, content, index }) => {
    try {
      const m = await loadMarp(namespace, path);
      if (m.error) return marpErr(m.error);
      const pos = index == null ? m.slides.length : Math.max(0, Math.min(m.slides.length, index - 1));
      m.slides.splice(pos, 0, String(content).trim());
      const err = await saveMarp(m.url, m.frontmatter, m.slides);
      if (err) return marpErr(err);
      return { content: [{ type: "text", text: `Added slide at position ${pos + 1}/${m.slides.length} in ${path}` }] };
    } catch (err) {
      return marpErr(`Error: ${err.message}`);
    }
  }
);

if (features.marp) server.tool(
  "list_marp_slides",
  "List the slides of a Marp deck: the deck's frontmatter plus, for each slide, its 1-based index, first non-empty line and length. Use the index with read/edit/delete/move_marp_slide.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the Marp deck note"),
  },
  async ({ namespace, path }) => {
    try {
      const m = await loadMarp(namespace, path);
      if (m.error) return marpErr(m.error);
      const slides = m.slides.map((s, i) => ({
        index: i + 1,
        firstLine: (s.split("\n").find((l) => l.trim() !== "") || "").trim().slice(0, 120),
        chars: s.length,
      }));
      return { content: [{ type: "text", text: JSON.stringify({ frontmatter: m.frontmatter, count: slides.length, slides }, null, 2) }] };
    } catch (err) {
      return marpErr(`Error: ${err.message}`);
    }
  }
);

if (features.marp) server.tool(
  "read_marp_slide",
  "Read the full markdown of one Marp slide by its 1-based index (from list_marp_slides).",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the Marp deck note"),
    index: z.number().describe("1-based slide index"),
  },
  async ({ namespace, path, index }) => {
    try {
      const m = await loadMarp(namespace, path);
      if (m.error) return marpErr(m.error);
      if (index < 1 || index > m.slides.length) return marpBadIndex(index, m.slides.length);
      return { content: [{ type: "text", text: m.slides[index - 1] }] };
    } catch (err) {
      return marpErr(`Error: ${err.message}`);
    }
  }
);

if (features.marp) server.tool(
  "edit_marp_slide",
  "Replace the markdown of one Marp slide by its 1-based index (from list_marp_slides). The frontmatter and other slides are untouched.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the Marp deck note"),
    index: z.number().describe("1-based slide index"),
    content: z.string().describe("New markdown body for the slide"),
  },
  async ({ namespace, path, index, content }) => {
    try {
      const m = await loadMarp(namespace, path);
      if (m.error) return marpErr(m.error);
      if (index < 1 || index > m.slides.length) return marpBadIndex(index, m.slides.length);
      m.slides[index - 1] = String(content).trim();
      const err = await saveMarp(m.url, m.frontmatter, m.slides);
      if (err) return marpErr(err);
      return { content: [{ type: "text", text: `Updated slide ${index}/${m.slides.length} in ${path}` }] };
    } catch (err) {
      return marpErr(`Error: ${err.message}`);
    }
  }
);

if (features.marp) server.tool(
  "delete_marp_slide",
  "Delete one Marp slide by its 1-based index (from list_marp_slides).",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the Marp deck note"),
    index: z.number().describe("1-based slide index"),
  },
  async ({ namespace, path, index }) => {
    try {
      const m = await loadMarp(namespace, path);
      if (m.error) return marpErr(m.error);
      if (index < 1 || index > m.slides.length) return marpBadIndex(index, m.slides.length);
      m.slides.splice(index - 1, 1);
      const err = await saveMarp(m.url, m.frontmatter, m.slides);
      if (err) return marpErr(err);
      return { content: [{ type: "text", text: `Deleted slide ${index}; ${m.slides.length} slide${m.slides.length === 1 ? "" : "s"} left in ${path}` }] };
    } catch (err) {
      return marpErr(`Error: ${err.message}`);
    }
  }
);

if (features.marp) server.tool(
  "move_marp_slide",
  "Reorder a Marp slide: move the slide at 1-based `from` to 1-based `to`.",
  {
    namespace: z.string().describe("Namespace name"),
    path: z.string().describe("Path to the Marp deck note"),
    from: z.number().describe("1-based current slide index"),
    to: z.number().describe("1-based target slide index"),
  },
  async ({ namespace, path, from, to }) => {
    try {
      const m = await loadMarp(namespace, path);
      if (m.error) return marpErr(m.error);
      const n = m.slides.length;
      if (from < 1 || from > n) return marpBadIndex(from, n);
      if (to < 1 || to > n) return marpBadIndex(to, n);
      const [s] = m.slides.splice(from - 1, 1);
      m.slides.splice(to - 1, 0, s);
      const err = await saveMarp(m.url, m.frontmatter, m.slides);
      if (err) return marpErr(err);
      return { content: [{ type: "text", text: `Moved slide ${from} -> ${to} in ${path}` }] };
    } catch (err) {
      return marpErr(`Error: ${err.message}`);
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
  // Read the backend's feature flags before building any server so the tool
  // surface only advertises what mdnest actually has enabled.
  await loadFeatures();
  if (httpMode) {
    await startHttp();
  } else {
    await startStdio();
  }
}

// Only auto-start when run as the entry point (node index.js); importing the
// module for unit tests must not spin up a transport.
const isEntry = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
