// Unit test for the Marp slide splitter/joiner. Pure (no server): checks that a
// deck round-trips through split/join, that a `---` inside fenced code does NOT
// start a new slide, and that the CRUD array transforms land where expected.
import { buildMarpDeck, splitMarp, joinMarp } from "./index.js";

let passed = 0, failed = 0;
const ok = (name, cond, extra = "") => { (cond ? passed++ : failed++); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); };

// Build + split.
const deck = buildMarpDeck({ theme: "gaia", paginate: true, slides: ["# A\n\nalpha", "# B\n\nbeta", "# C"] });
let { frontmatter, slides } = splitMarp(deck);
ok("frontmatter carries marp:true", /marp:\s*true/.test(frontmatter));
ok("frontmatter carries theme", /theme:\s*gaia/.test(frontmatter));
ok("split finds 3 slides", slides.length === 3, `got ${slides.length}`);
ok("slide bodies preserved", slides[0].includes("alpha") && slides[1].includes("beta"));

// A `---` inside a fenced code block must not split.
const withCode = "---\nmarp: true\n---\n\n# One\n\n```\n---\nnot a slide\n```\n\n---\n\n# Two";
const sc = splitMarp(withCode);
ok("fenced --- does not split", sc.slides.length === 2, `got ${sc.slides.length}`);
ok("fenced content kept intact", sc.slides[0].includes("not a slide"));

// Round-trip: join then re-split is stable.
const rejoined = joinMarp(frontmatter, slides);
const again = splitMarp(rejoined);
ok("round-trip keeps slide count", again.slides.length === 3);
ok("round-trip keeps frontmatter", /marp:\s*true/.test(again.frontmatter));

// CRUD transforms (what the tools do to the slides array).
let s = again.slides.slice();
s.splice(1, 0, "# Inserted"); // add at index 2
ok("add inserts at position", splitMarp(joinMarp(frontmatter, s)).slides[1].startsWith("# Inserted"));
s[0] = "# Edited"; // edit slide 1
ok("edit replaces a slide", splitMarp(joinMarp(frontmatter, s)).slides[0] === "# Edited");
const before = s.length;
s.splice(2, 1); // delete slide 3
ok("delete removes a slide", splitMarp(joinMarp(frontmatter, s)).slides.length === before - 1);
const [moved] = s.splice(0, 1); s.push(moved); // move slide 1 to the end
const final = splitMarp(joinMarp(frontmatter, s)).slides;
ok("move reorders", final[final.length - 1] === "# Edited");

console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
