// Pure helpers for shared editing (no React, no Yjs). Imported only by the
// lazily loaded shared editing chunk (sharedDoc.js), so diff-match-patch is
// never in the entry bundle.
import DiffMatchPatch from 'diff-match-patch';

// --- Front matter ----------------------------------------------------------
//
// Front matter is kept out of the shared editor. The Live editor does not
// understand YAML front matter: on save it turns the `---` fences into `***`
// and a setext heading, which breaks the note for every tool that reads it.
// So the block is split off before the text goes into the editor, kept as its
// own value in the shared document, and put back in front on every save.
//
// The split keeps the blank lines after the closing fence with the front
// matter, so "front matter + serialized body" gives back the same separation
// the file had.

const FM_OPEN = /^---[ \t]*\r?\n/;
const FM_CLOSE = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(text) {
  const s = typeof text === 'string' ? text : '';
  const open = s.match(FM_OPEN);
  if (!open) return { frontMatter: '', body: s };
  let pos = open[0].length;
  while (pos <= s.length) {
    const rest = s.slice(pos);
    const close = rest.match(FM_CLOSE);
    if (close) {
      let end = pos + close[0].length;
      // Blank lines after the fence belong to the separation.
      const blanks = s.slice(end).match(/^(?:[ \t]*\r?\n)*/);
      if (blanks) end += blanks[0].length;
      return { frontMatter: s.slice(0, end), body: s.slice(end) };
    }
    const nl = s.indexOf('\n', pos);
    if (nl === -1) break;
    pos = nl + 1;
  }
  // An opening fence with no close is not front matter.
  return { frontMatter: '', body: s };
}

export function joinFrontMatter(frontMatter, body) {
  if (!frontMatter) return body || '';
  // A close fence at the very end of the file has no newline after it.
  const fm = /\n$/.test(frontMatter) ? frontMatter : frontMatter + '\n';
  return fm + (body || '');
}

// --- Three-way merge ---------------------------------------------------------
//
// An outside change (git-sync, the CLI, an agent, a restore) reaches a room
// that may hold unsaved text of its own. Line-based three-way merge, like
// diff3: `base` is the text the room last saved or loaded, `ours` what the
// room has now, `theirs` the file on disk. A part changed on one side takes
// that side; a part changed the same way on both sides is taken once; a part
// changed differently on both keeps both, ours first, so nobody's words are
// dropped.

function lineMatches(dmp, a, b) {
  // diff-match-patch's line mode: each line becomes one character, so the
  // diff is over lines. Returns, for every line of `a`, the index of the
  // matching line in `b` or -1. The pairs are increasing on both sides.
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(a, b);
  const diffs = dmp.diff_main(chars1, chars2, false);
  void lineArray;
  const map = [];
  let j = 0;
  for (const [op, chunk] of diffs) {
    const n = chunk.length;
    if (op === 0) {
      for (let k = 0; k < n; k += 1) map.push(j + k);
      j += n;
    } else if (op === -1) {
      for (let k = 0; k < n; k += 1) map.push(-1);
    } else {
      j += n;
    }
  }
  return map;
}

function splitLines(s) {
  // Keep the newline on each line so joining gives the exact text back.
  const out = s.match(/[^\n]*\n|[^\n]+$/g);
  return out || [];
}

const sameLines = (x, y) => x.length === y.length && x.every((l, i) => l === y[i]);

// report, when given, gets `conflicts`: how many places both sides changed
// the same lines differently, so both versions were kept.
export function mergeThreeWay(base, ours, theirs, report) {
  if (report) report.conflicts = 0;
  base = base || '';
  ours = ours || '';
  theirs = theirs || '';
  if (ours === theirs) return ours;
  if (ours === base) return theirs;
  if (theirs === base) return ours;

  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 2;
  const A = splitLines(base);
  const B = splitLines(ours);
  const C = splitLines(theirs);
  const mb = lineMatches(dmp, base, ours);
  const mc = lineMatches(dmp, base, theirs);

  const out = [];
  let ia = 0;
  let ib = 0;
  let ic = 0;
  const flush = (ea, eb, ec) => {
    const a = A.slice(ia, ea);
    const b = B.slice(ib, eb);
    const c = C.slice(ic, ec);
    if (sameLines(a, b)) out.push(...c);
    else if (sameLines(a, c)) out.push(...b);
    else if (sameLines(b, c)) out.push(...b);
    else {
      if (report) report.conflicts += 1;
      out.push(...b);
      // Keep both versions readable as separate lines.
      if (b.length && !/\n$/.test(b[b.length - 1])) out.push('\n');
      out.push(...c);
    }
  };
  for (let i = 0; i < A.length; i += 1) {
    // A stable line: present, unchanged, on both sides, after both cursors.
    if (mb[i] >= ib && mc[i] >= ic) {
      flush(i, mb[i], mc[i]);
      out.push(A[i]);
      ia = i + 1;
      ib = mb[i] + 1;
      ic = mc[i] + 1;
    }
  }
  flush(A.length, B.length, C.length);
  return out.join('');
}

// --- Frames ------------------------------------------------------------------
//
// Binary websocket frames, matching backend/collab/yjs.go.

export const TAG_UPDATE = 1;
export const TAG_AWARENESS = 2;
export const TAG_SNAPSHOT = 3;
export const TAG_STATE = 4;

export function encodeFrame(tag, payload) {
  const out = new Uint8Array(1 + payload.length);
  out[0] = tag;
  out.set(payload, 1);
  return out;
}

function putU64(view, off, n) {
  view.setUint32(off, Math.floor(n / 2 ** 32));
  view.setUint32(off + 4, n >>> 0);
}

function getU64(view, off) {
  return view.getUint32(off) * 2 ** 32 + view.getUint32(off + 4);
}

export function encodeSnapshot(ackSeq, payload) {
  const out = new Uint8Array(9 + payload.length);
  out[0] = TAG_SNAPSHOT;
  putU64(new DataView(out.buffer), 1, ackSeq);
  out.set(payload, 9);
  return out;
}

// Decodes a server frame: { tag, seq?, payload?, entries? }. null if malformed.
export function decodeServerFrame(u8) {
  if (!u8 || u8.length < 1) return null;
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = u8[0];
  if (tag === TAG_UPDATE) {
    if (u8.length < 9) return null;
    return { tag, seq: getU64(view, 1), payload: u8.subarray(9) };
  }
  if (tag === TAG_AWARENESS) {
    // Stamped by the server with the sender's account id.
    if (u8.length < 5) return null;
    return { tag, userId: view.getUint32(1), payload: u8.subarray(5) };
  }
  if (tag === TAG_STATE) {
    if (u8.length < 9) return null;
    const entries = [];
    let p = 9;
    while (p + 4 <= u8.length) {
      const n = view.getUint32(p);
      if (p + 4 + n > u8.length) return null;
      entries.push(u8.subarray(p + 4, p + 4 + n));
      p += 4 + n;
    }
    return { tag, seq: getU64(view, 1), entries };
  }
  return null;
}
