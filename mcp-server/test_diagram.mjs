// Unit test for the Excalidraw diagram compiler. Pure (no server/backend):
// imports the builders from index.js and checks that a nodes+edges spec
// compiles to a valid scene with symmetric arrow bindings, serializes to the
// Obsidian .excalidraw.md layout, and round-trips back to the same diagram.
import { compileDiagram, buildExcalidraw, sceneToDiagram } from "./index.js";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

const nodes = [
  { id: "a", text: "Start", shape: "ellipse" },
  { id: "b", text: "Work", shape: "rectangle" },
  { id: "c", text: "End", shape: "diamond" },
];
const edges = [
  { from: "a", to: "b", text: "go" },
  { from: "b", to: "c", dashed: true },
];

const els = compileDiagram({ nodes, edges });
const shapes = els.filter((e) => ["rectangle", "ellipse", "diamond"].includes(e.type));
const arrows = els.filter((e) => e.type === "arrow");
const texts = els.filter((e) => e.type === "text");

ok("3 shapes compiled", shapes.length === 3, `got ${shapes.length}`);
ok("2 arrows compiled", arrows.length === 2, `got ${arrows.length}`);
ok("labels compiled (3 node + 1 edge)", texts.length === 4, `got ${texts.length}`);

// Required Excalidraw bookkeeping fields present.
const reqShape = shapes.every((s) => s.id && typeof s.seed === "number" && typeof s.versionNonce === "number" && "boundElements" in s && s.width > 0);
ok("shapes carry required fields", reqShape);
const reqArrow = arrows.every((a) => Array.isArray(a.points) && a.points.length === 2 && a.startBinding && a.endBinding && a.endArrowhead === "arrow");
ok("arrows carry points + bindings", reqArrow);
ok("dashed edge honoured", arrows.some((a) => a.strokeStyle === "dashed"));

// Binding symmetry: every arrow endpoint shape references the arrow back.
const byId = new Map(els.map((e) => [e.id, e]));
const symmetric = arrows.every((a) => {
  const s = byId.get(a.startBinding.elementId);
  const t = byId.get(a.endBinding.elementId);
  const refs = (el) => (el.boundElements || []).some((b) => b.id === a.id && b.type === "arrow");
  return s && t && refs(s) && refs(t);
});
ok("arrow<->shape bindings are symmetric", symmetric);

// Bound labels reference their container and vice-versa.
const labelsBound = texts.every((t) => {
  const c = byId.get(t.containerId);
  return c && (c.boundElements || []).some((b) => b.id === t.id && b.type === "text");
});
ok("labels bound to their container", labelsBound);

// Serialize -> the scene must be valid JSON inside the fenced block.
const md = buildExcalidraw({ elements: els });
ok("serialized with frontmatter + drawing", md.includes("excalidraw-plugin: parsed") && md.includes("## Drawing"));
const fence = md.match(/```json\s*\n([\s\S]*?)\n```/);
let sceneOk = false;
try { const sc = JSON.parse(fence[1]); sceneOk = sc.type === "excalidraw" && Array.isArray(sc.elements); } catch { /* */ }
ok("drawing block is valid JSON", sceneOk);
ok("text elements mirrored for search", md.includes("Start ^") && md.includes("Work ^"));

// Round-trip: parse the markdown back to the high-level diagram.
const back = sceneToDiagram(md);
ok("round-trip node count", back.nodeCount === 3, `got ${back.nodeCount}`);
ok("round-trip edge count", back.edgeCount === 2, `got ${back.edgeCount}`);
ok("round-trip preserves labels", back.nodes.filter((n) => n.text).length === 3);
ok("round-trip edges resolve endpoints", back.edges.every((e) => e.from && e.to));

// Append mode: connect a new node to an existing shape by its element id.
const existingShapeId = shapes[2].id; // "End"
const more = compileDiagram({
  nodes: [{ id: "d", text: "Retry" }],
  edges: [{ from: "d", to: existingShapeId }],
  existingElements: els,
});
ok("append keeps existing + adds new", more.length === els.length + 3, `got ${more.length} vs ${els.length}`); // new shape + its label + arrow
const newArrow = more.filter((e) => e.type === "arrow").pop();
const endShape = more.find((e) => e.id === existingShapeId);
ok("append edge binds to existing shape", newArrow.endBinding.elementId === existingShapeId && (endShape.boundElements || []).some((b) => b.id === newArrow.id));

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
