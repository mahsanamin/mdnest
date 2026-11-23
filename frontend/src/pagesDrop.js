// Drop HTML from the desktop onto a tree folder to publish it as a page
// (server: ENABLE_PAGES). Loaded on the first such drop, never otherwise.
//
// What a drop becomes:
//   - one .html file: a page named after the file;
//   - a folder with an index.html: that folder, as one page;
//   - a folder with no index.html but exactly one top-level .html: that
//     file as index.html, the rest kept beside it;
//   - a browser "Save page as, Webpage complete" pair, X.html plus X_files/,
//     dropped together: X.html as index.html and X_files/ kept beside it, so
//     its relative links still work.
// Anything without HTML is not a page: plan.kind is 'none' and the drop does
// what it did before (nothing). The server checks every path, the size and the
// file count again; the checks here only give a clear message before
// uploading.

const isHTML = (name) => /\.html?$/i.test(name);
const isHidden = (path) => path.split('/').some((seg) => seg.startsWith('.'));

// slugify turns a file or folder name into a page name: lowercase letters,
// digits and hyphens, at most 64 characters, never empty.
export function slugify(name) {
  const base = String(name || '').replace(/\.html?$/i, '');
  const slug = base
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 64).replace(/-+$/, '');
  return slug || 'page';
}

function readEntries(dirEntry) {
  const reader = dirEntry.createReader();
  const all = [];
  return new Promise((resolve, reject) => {
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) { resolve(all); return; }
      all.push(...batch);
      next();
    }, reject);
    next();
  });
}

const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

// walk returns [{ path, file }] for every file under an entry, paths relative
// to the drop (a dropped folder's name is the first segment).
async function walk(entry, prefix = '') {
  const path = prefix + entry.name;
  if (entry.isFile) return [{ path, file: await entryFile(entry) }];
  if (!entry.isDirectory) return [];
  const out = [];
  for (const child of await readEntries(entry)) out.push(...await walk(child, path + '/'));
  return out;
}

// gather reads the drop into a flat list, with the top-level names kept apart.
async function gather({ entries, files }) {
  if (entries.length) {
    const list = [];
    const top = [];
    for (const e of entries) {
      top.push({ name: e.name, dir: e.isDirectory });
      list.push(...await walk(e));
    }
    return { list, top };
  }
  // No entry API: plain files only.
  return { list: files.map((f) => ({ path: f.name, file: f })), top: files.map((f) => ({ name: f.name, dir: false })) };
}

// planDrop decides what a drop publishes. It returns
//   { kind: 'none' }                       nothing to publish (not HTML)
//   { kind: 'error', message }             HTML, but not something we can publish
//   { kind: 'page', name, files: [{ path, file }], bytes }
// dropped is { entries, files } as App's drop handler collected them
// synchronously (webkitGetAsEntry entries, or plain files without the API).
export async function planDrop(dropped, { maxMB = 20, maxFiles = 500 } = {}) {
  const { list, top } = await gather(dropped);
  const visible = list.filter((f) => !isHidden(f.path));
  if (!visible.some((f) => isHTML(f.path))) return { kind: 'none' };

  const topFiles = top.filter((t) => !t.dir).map((t) => t.name);
  const topDirs = top.filter((t) => t.dir).map((t) => t.name);
  const under = (dir) => visible.filter((f) => f.path.startsWith(dir + '/'));
  let name;
  let files;

  // "Webpage, complete": X.html beside X_files/.
  const saved = topFiles.find((f) => isHTML(f) && topDirs.includes(f.replace(/\.html?$/i, '') + '_files'));
  if (saved) {
    const assets = saved.replace(/\.html?$/i, '') + '_files';
    name = saved;
    files = [
      { path: 'index.html', file: visible.find((f) => f.path === saved).file },
      ...under(assets),
    ];
  } else if (topDirs.length === 1 && topFiles.length === 0) {
    const dir = topDirs[0];
    const inside = under(dir).map((f) => ({ path: f.path.slice(dir.length + 1), file: f.file }));
    const rootHTML = inside.filter((f) => !f.path.includes('/') && isHTML(f.path));
    if (inside.some((f) => f.path === 'index.html')) {
      files = inside;
    } else if (rootHTML.length === 1) {
      files = inside.map((f) => (f === rootHTML[0] ? { path: 'index.html', file: f.file } : f));
    } else if (rootHTML.length === 0) {
      return { kind: 'error', message: `The folder ${dir} has no index.html or .html file at its top level, so it is not a page.` };
    } else {
      return { kind: 'error', message: `The folder ${dir} has several .html files and no index.html. Add an index.html, or drop one .html file.` };
    }
    name = dir;
  } else if (topDirs.length === 0 && topFiles.length === 1 && isHTML(topFiles[0])) {
    name = topFiles[0];
    files = [{ path: 'index.html', file: visible.find((f) => f.path === topFiles[0]).file }];
  } else {
    return { kind: 'error', message: 'Drop one page at a time: one .html file, one folder with an index.html, or a saved web page (its .html file together with its _files folder).' };
  }

  const bytes = files.reduce((n, f) => n + f.file.size, 0);
  if (files.length > maxFiles) {
    return { kind: 'error', message: `This page has ${files.length} files. The server takes at most ${maxFiles} (PAGES_MAX_FILES).` };
  }
  if (bytes > maxMB * 1024 * 1024) {
    return { kind: 'error', message: `This page is ${(bytes / 1048576).toFixed(1)} MB. The server takes at most ${maxMB} MB (PAGES_MAX_MB).` };
  }
  for (const f of files) {
    if (tarNameFields(f.path) === null) {
      return { kind: 'error', message: `The path ${f.path} is too long for a page.` };
    }
  }
  return { kind: 'page', name: slugify(name), files, bytes };
}

const enc = new TextEncoder();

// tarNameFields splits a path into the ustar name (100 bytes) and prefix
// (155 bytes) fields, or returns null when it does not fit.
function tarNameFields(path) {
  if (enc.encode(path).length <= 100) return { name: path, prefix: '' };
  for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) {
    const prefix = path.slice(0, cut);
    const name = path.slice(cut + 1);
    if (enc.encode(name).length <= 100 && enc.encode(prefix).length <= 155) return { name, prefix };
  }
  return null;
}

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function header(path, size) {
  const h = new Uint8Array(512);
  const put = (off, str) => h.set(enc.encode(str), off);
  const { name, prefix } = tarNameFields(path);
  put(0, name);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(Math.floor(Date.now() / 1000), 12));
  h.fill(0x20, 148, 156); // the checksum is computed with this field as spaces
  h[156] = 0x30; // '0': a regular file
  put(257, 'ustar\0');
  put(263, '00');
  put(345, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

// buildTar packs [{ path, file }] into a ustar Blob, without reading the files
// into memory first: the Blob holds references to them.
export function buildTar(files) {
  const parts = [];
  for (const f of files) {
    parts.push(header(f.path, f.file.size), f.file);
    const pad = (512 - (f.file.size % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  return new Blob(parts, { type: 'application/x-tar' });
}

// treeHas reports whether the tree lists a file at path.
export function treeHas(tree, path) {
  const stack = Array.isArray(tree) ? [...tree] : [];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.type === 'file' && n.path === path) return true;
    if (Array.isArray(n.children)) stack.push(...n.children);
  }
  return false;
}

// pageBody is what a planned page uploads: one HTML file as text/html, a
// folder as a tar.
export function pageBody(plan) {
  if (plan.files.length === 1) return { body: plan.files[0].file, contentType: 'text/html' };
  return { body: buildTar(plan.files), contentType: 'application/x-tar' };
}
