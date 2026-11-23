// Dropping HTML from the desktop onto a tree folder (pagesDrop.js): what a
// drop becomes, the limits checked before uploading, and the tar it builds.
import { describe, it, expect } from 'vitest';
import { planDrop, slugify, buildTar, treeHas, pageBody } from '../pagesDrop.js';

// Minimal stand-ins for the FileSystem entry API a drop hands out.
function fileEntry(name, body) {
  const file = new File([body], name);
  return { name, isFile: true, isDirectory: false, file: (ok) => ok(file) };
}
function dirEntry(name, children) {
  return {
    name, isFile: false, isDirectory: true,
    createReader() {
      let done = false;
      return { readEntries(ok) { const batch = done ? [] : children; done = true; ok(batch); } };
    },
  };
}
const drop = (...entries) => ({ entries, files: [] });
const paths = (plan) => plan.files.map((f) => f.path).sort();

describe('planDrop', () => {
  it('one .html file becomes a page named after the file', async () => {
    const plan = await planDrop(drop(fileEntry('Q3 Report (final).html', '<p>x</p>')));
    expect(plan.kind).toBe('page');
    expect(plan.name).toBe('q3-report-final');
    expect(paths(plan)).toEqual(['index.html']);
    expect(pageBody(plan).contentType).toBe('text/html');
  });

  it('a browser "Webpage, complete" save: X.html becomes index.html and X_files/ stays beside it', async () => {
    const plan = await planDrop(drop(
      fileEntry('Sales dashboard.html', '<link href="Sales dashboard_files/a.css"><img src="Sales dashboard_files/chart.png">'),
      dirEntry('Sales dashboard_files', [fileEntry('a.css', 'p{}'), fileEntry('chart.png', 'PNG'), dirEntry('js', [fileEntry('x.js', '1')])]),
    ));
    expect(plan.kind).toBe('page');
    expect(plan.name).toBe('sales-dashboard');
    expect(paths(plan)).toEqual(['Sales dashboard_files/a.css', 'Sales dashboard_files/chart.png', 'Sales dashboard_files/js/x.js', 'index.html']);
    expect(pageBody(plan).contentType).toBe('application/x-tar');
  });

  it('a folder with index.html is one page; hidden files are left out', async () => {
    const plan = await planDrop(drop(dirEntry('report', [fileEntry('index.html', 'i'), fileEntry('.DS_Store', 'x'), dirEntry('css', [fileEntry('s.css', 's')])])));
    expect(plan.name).toBe('report');
    expect(paths(plan)).toEqual(['css/s.css', 'index.html']);
  });

  it('a folder with no index.html but one top-level .html uses it as index', async () => {
    const plan = await planDrop(drop(dirEntry('out', [fileEntry('main.html', 'm'), fileEntry('data.json', '{}')])));
    expect(paths(plan)).toEqual(['data.json', 'index.html']);
  });

  it('refuses what is HTML but not one page, with a clear message', async () => {
    let plan = await planDrop(drop(dirEntry('out', [fileEntry('a.html', 'a'), fileEntry('b.html', 'b')])));
    expect(plan.kind).toBe('error');
    expect(plan.message).toMatch(/several .html files and no index.html/);
    plan = await planDrop(drop(fileEntry('a.html', 'a'), fileEntry('b.html', 'b')));
    expect(plan.message).toMatch(/one page at a time/);
  });

  it('anything without HTML is not a page: the drop does what it did before', async () => {
    expect((await planDrop(drop(fileEntry('photo.png', 'x')))).kind).toBe('none');
    expect((await planDrop(drop(dirEntry('docs', [fileEntry('a.md', '#')])))).kind).toBe('none');
    expect((await planDrop({ entries: [], files: [] })).kind).toBe('none');
  });

  it('checks the size and file count before uploading', async () => {
    const big = await planDrop(drop(fileEntry('big.html', 'x'.repeat(2 * 1024 * 1024))), { maxMB: 1 });
    expect(big.kind).toBe('error');
    expect(big.message).toMatch(/at most 1 MB \(PAGES_MAX_MB\)/);
    const many = await planDrop(drop(dirEntry('m', [fileEntry('index.html', 'i'), fileEntry('1', '1'), fileEntry('2', '2')])), { maxFiles: 2 });
    expect(many.message).toMatch(/3 files\. The server takes at most 2 \(PAGES_MAX_FILES\)/);
  });
});

describe('slugify', () => {
  it('makes a page name the server accepts', () => {
    expect(slugify('Ümlaut Café.HTML')).toBe('umlaut-cafe');
    expect(slugify('---')).toBe('page');
    expect(slugify('a'.repeat(80) + '.html')).toHaveLength(64);
    expect(slugify('Q3/report')).toBe('q3-report');
  });
});

describe('buildTar', () => {
  it('writes a ustar the server can read: names, sizes, checksum, long paths in the prefix field', async () => {
    const long = 'assets/' + 'd'.repeat(80) + '/' + 'f'.repeat(60) + '.json';
    const blob = buildTar([{ path: 'index.html', file: new File(['<p>hi</p>'], 'x') }, { path: long, file: new File(['{}'], 'y') }]);
    const buf = new Uint8Array(await blob.arrayBuffer());
    const str = (off, len) => new TextDecoder().decode(buf.slice(off, off + len)).replace(/\0.*$/s, '');
    expect(str(0, 100)).toBe('index.html');
    expect(parseInt(str(124, 12), 8)).toBe(9);
    expect(str(257, 6)).toBe('ustar');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : buf[i];
    expect(parseInt(str(148, 8), 8)).toBe(sum);
    const h2 = 1024; // 512 header + 9 bytes padded to 512
    expect(str(h2 + 345, 155) + '/' + str(h2, 100)).toBe(long);
    expect(buf.length).toBe(512 * 2 + 512 * 2 + 1024);
  });
});

describe('treeHas', () => {
  it('finds a handle in the tree', () => {
    const tree = [{ type: 'folder', path: 'A', children: [{ type: 'file', path: 'A/x.page.md' }] }];
    expect(treeHas(tree, 'A/x.page.md')).toBe(true);
    expect(treeHas(tree, 'A/y.page.md')).toBe(false);
  });
});
