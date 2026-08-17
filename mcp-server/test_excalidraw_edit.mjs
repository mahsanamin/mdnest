// Unit test for element-level Excalidraw edits. Pure (no server): builds a
// scene, then exercises editExcalidrawNode / editExcalidrawEdge /
// deleteExcalidrawElement and checks the scene stays valid and consistent.
import {
  compileDiagram, buildExcalidraw, parseScene, sceneToDiagram,
  editExcalidrawNode, editExcalidrawEdge, deleteExcalidrawElement,
} from "./index.js";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

// Build a 3-node / 2-edge diagram and round-trip through the note format.
const md0 = buildExcalidraw({ elements: compileDiagram({
  nodes: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }],
  edges: [{ from: "a", to: "b", text: "ab" }, { from: "b", to: "c" }],
}) });
let { elements } = parseScene(md0);
const view0 = sceneToDiagram(md0);
const nodeA = view0.nodes.find((n) => n.text === "A").id;
const nodeB = view0.nodes.find((n) => n.text === "B").id;
const edgeAB = view0.edges.find((e) => e.text === "ab").id;
ok("read exposes node + edge ids", !!nodeA && !!nodeB && !!edgeAB);

// Edit a node: relabel, move, change shape. Connected arrow must re-flow.
let r = editExcalidrawNode(elements, nodeA, { text: "Start", shape: "diamond", x: 500, y: 500 });
ok("edit node ok", !r.error);
elements = r.elements;
const aEl = elements.find((e) => e.id === nodeA);
ok("node relabelled + reshaped + moved", aEl.type === "diamond" && aEl.x === 500);
const abArrow = elements.find((e) => e.id === edgeAB);
ok("connected arrow re-flowed to new centre", abArrow.x === aEl.x + aEl.width / 2, `arrow.x=${abArrow.x}`);
const aLabel = elements.find((e) => e.type === "text" && e.containerId === nodeA);
ok("node label updated", aLabel && aLabel.text === "Start");

// Edit an edge: label + dashed.
r = editExcalidrawEdge(elements, edgeAB, { text: "flows", dashed: true });
ok("edit edge ok", !r.error);
elements = r.elements;
const abEl = elements.find((e) => e.id === edgeAB);
ok("edge dashed + labelled", abEl.strokeStyle === "dashed" && elements.some((e) => e.type === "text" && e.containerId === edgeAB && e.text === "flows"));

// Delete a node in the middle: it and both its arrows (a-b, b-c) and labels go.
const before = elements.length;
r = deleteExcalidrawElement(elements, nodeB);
ok("delete node ok", !r.error);
elements = r.elements;
ok("node B gone", !elements.some((e) => e.id === nodeB));
ok("arrows touching B gone", !elements.some((e) => e.type === "arrow" && (e.startBinding?.elementId === nodeB || e.endBinding?.elementId === nodeB)));
ok("removed several elements", r.removed >= 3, `removed=${r.removed}`);
ok("no dangling boundElements refs", elements.every((e) => !Array.isArray(e.boundElements) || e.boundElements.every((b) => elements.some((x) => x.id === b.id))));

// Scene still serializes to valid JSON.
const md1 = buildExcalidraw({ elements });
const fence = md1.match(/```json\s*\n([\s\S]*?)\n```/);
let valid = false;
try { valid = JSON.parse(fence[1]).type === "excalidraw"; } catch { /* */ }
ok("edited scene serializes valid JSON", valid);
ok("delete not larger than before", elements.length < before);

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
