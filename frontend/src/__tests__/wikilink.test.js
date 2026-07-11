// @vitest-environment jsdom

// Unit tests for Obsidian-style wikilink support ([[...]]) in the preview.
// Same narrow pure-helper style as markdown-fixtures.test.js: everything
// goes through the exported functions in src/wikilink.js plus a Marked
// instance configured exactly like Preview.jsx builds it (breaks + gfm,
// extension registered via .use() which merges with the defaults).

import { describe, it, expect } from 'vitest';
import { Marked } from 'marked';
import {
  parseWikiLink,
  buildPathIndex,
  resolveWikiLink,
  buildHashHref,
  wikiLinkExtension,
  resolveRelativeMdHref,
  internalMdLinkHtml,
  restoreWikilinks,
} from '../wikilink.js';

describe('parseWikiLink', () => {
  it('parses a plain target', () => {
    expect(parseWikiLink('Some Note')).toEqual({
      page: 'Some Note', heading: '', alias: '', display: 'Some Note',
    });
  });

  it('parses target|alias (first pipe wins)', () => {
    expect(parseWikiLink('Some Note|shown text')).toEqual({
      page: 'Some Note', heading: '', alias: 'shown text', display: 'shown text',
    });
    expect(parseWikiLink('a|b|c').alias).toBe('b|c');
  });

  it('parses target#heading (first hash wins)', () => {
    expect(parseWikiLink('Some Note#Section')).toEqual({
      page: 'Some Note', heading: 'Section', alias: '', display: 'Some Note#Section',
    });
  });

  it('parses #heading with empty page (same-note link)', () => {
    expect(parseWikiLink('#Section')).toEqual({
      page: '', heading: 'Section', alias: '', display: '#Section',
    });
  });

  it('parses target#heading|alias', () => {
    expect(parseWikiLink('dir/note#Head|nice')).toEqual({
      page: 'dir/note', heading: 'Head', alias: 'nice', display: 'nice',
    });
  });

  it('trims whitespace around all parts', () => {
    expect(parseWikiLink('  Some Note  |  alias  ')).toEqual({
      page: 'Some Note', heading: '', alias: 'alias', display: 'alias',
    });
  });
});

// Fixture tree in the shape GET /api/tree returns (App.jsx stores
// data.children, so buildPathIndex receives the array).
const TREE = [
  { name: 'Inbox.md', path: 'Inbox.md', type: 'file' },
  { name: 'photo.png', path: 'photo.png', type: 'file' },
  {
    name: 'projects', path: 'projects', type: 'folder',
    children: [
      { name: 'Roadmap.md', path: 'projects/Roadmap.md', type: 'file' },
      {
        name: 'deep', path: 'projects/deep', type: 'folder',
        children: [
          { name: 'Roadmap.md', path: 'projects/deep/Roadmap.md', type: 'file' },
          { name: 'notes.md', path: 'projects/deep/notes.md', type: 'file' },
        ],
      },
    ],
  },
  {
    name: 'archive', path: 'archive', type: 'directory',
    children: [
      { name: 'Old Ideas.md', path: 'archive/Old Ideas.md', type: 'file' },
    ],
  },
];

const INDEX = buildPathIndex(TREE);

describe('buildPathIndex', () => {
  it('collects every .md path, recursively, for folder and directory types', () => {
    expect(INDEX.paths.has('Inbox.md')).toBe(true);
    expect(INDEX.paths.has('projects/deep/notes.md')).toBe(true);
    expect(INDEX.paths.has('archive/Old Ideas.md')).toBe(true);
  });

  it('does not index non-markdown files or folders', () => {
    expect(INDEX.paths.has('photo.png')).toBe(false);
    expect(INDEX.paths.has('projects')).toBe(false);
  });
});

describe('resolveWikiLink', () => {
  it('resolves a full path with .md suffix', () => {
    expect(resolveWikiLink('projects/Roadmap.md', INDEX, null)).toBe('projects/Roadmap.md');
  });

  it('resolves a full path without .md suffix', () => {
    expect(resolveWikiLink('projects/Roadmap', INDEX, null)).toBe('projects/Roadmap.md');
  });

  it('resolves a full path case-insensitively', () => {
    expect(resolveWikiLink('PROJECTS/roadmap', INDEX, null)).toBe('projects/Roadmap.md');
  });

  it('resolves a unique bare name case-insensitively', () => {
    expect(resolveWikiLink('inbox', INDEX, null)).toBe('Inbox.md');
    expect(resolveWikiLink('old ideas', INDEX, null)).toBe('archive/Old Ideas.md');
    expect(resolveWikiLink('notes.md', INDEX, null)).toBe('projects/deep/notes.md');
  });

  it('breaks an ambiguous bare name by shortest path', () => {
    expect(resolveWikiLink('Roadmap', INDEX, null)).toBe('projects/Roadmap.md');
  });

  it('returns null for an unknown target', () => {
    expect(resolveWikiLink('does-not-exist', INDEX, null)).toBe(null);
    expect(resolveWikiLink('nope/missing.md', INDEX, null)).toBe(null);
  });

  it('returns the current note for an empty page ([[#heading]])', () => {
    expect(resolveWikiLink('', INDEX, 'projects/Roadmap.md')).toBe('projects/Roadmap.md');
    expect(resolveWikiLink('', INDEX, null)).toBe(null);
  });
});

// Mirror of Preview.jsx's setup: new Marked + .use() merge.
function makeRenderer(currentPath) {
  const inst = new Marked({ breaks: true, gfm: true });
  inst.use(wikiLinkExtension({
    resolve: (page) => resolveWikiLink(page, INDEX, currentPath),
    ns: 'work',
  }));
  inst.use({
    renderer: {
      link({ href, title, text }) {
        const internal = internalMdLinkHtml({ href, title, text }, 'work', currentPath);
        if (internal) return internal;
        const titleAttr = title ? ` title="${title}"` : '';
        return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
      },
    },
  });
  return (src) => inst.parse(src);
}

describe('wikilink rendering through marked', () => {
  const render = makeRenderer('projects/deep/notes.md');

  it('renders a resolved wikilink as an internal anchor', () => {
    const html = render('See [[Inbox]] for details.');
    expect(html).toContain('<a class="wikilink" href="#work/Inbox.md" data-path="Inbox.md">Inbox</a>');
    expect(html).not.toContain('target="_blank"');
  });

  it('renders the alias as the display text', () => {
    const html = render('[[projects/Roadmap|the plan]]');
    expect(html).toContain('data-path="projects/Roadmap.md"');
    expect(html).toContain('>the plan</a>');
  });

  it('carries the heading in a data attribute', () => {
    const html = render('[[Inbox#Todo]]');
    expect(html).toContain('data-heading="Todo"');
    expect(html).toContain('>Inbox#Todo</a>');
  });

  it('renders [[#heading]] as a link to the current note', () => {
    const html = render('[[#Setup]]');
    expect(html).toContain('data-path="projects/deep/notes.md"');
    expect(html).toContain('data-heading="Setup"');
  });

  it('renders an unresolved wikilink as a broken, non-clickable span', () => {
    const html = render('[[Ghost Note]]');
    expect(html).toContain('<span class="wikilink wikilink-broken" title="Note not found: Ghost Note">Ghost Note</span>');
    expect(html).not.toContain('<a class="wikilink"');
  });

  it('percent-encodes hash href segments (spaces)', () => {
    const html = render('[[Old Ideas]]');
    expect(html).toContain('href="#work/archive/Old%20Ideas.md"');
  });

  it('escapes HTML in display text and title', () => {
    const html = render('[[<b>nope</b>]]');
    expect(html).not.toContain('<b>nope</b>');
    expect(html).toContain('&lt;b&gt;nope&lt;/b&gt;');
  });

  it('does NOT link [[...]] inside inline code spans', () => {
    const html = render("Use `[['field' => 'x']]` in config.");
    expect(html).not.toContain('wikilink');
    expect(html).toContain('<code>');
  });

  it('does NOT link [[...]] inside fenced code blocks', () => {
    const html = render("```php\n$x = [['field' => 'x']];\n```");
    expect(html).not.toContain('wikilink');
    expect(html).toContain('language-php');
  });

  it('does not match across newlines or empty targets', () => {
    expect(render('a [[\nb]] c')).not.toContain('wikilink');
    expect(render('a [[]] c')).not.toContain('wikilink');
  });
});

describe('resolveRelativeMdHref', () => {
  it('resolves a sibling .md link against the note directory', () => {
    expect(resolveRelativeMdHref('other.md', 'dir/current.md')).toEqual({ path: 'dir/other.md', heading: '' });
  });

  it('normalizes ../ and ./', () => {
    expect(resolveRelativeMdHref('../top.md', 'dir/sub/current.md')).toEqual({ path: 'dir/top.md', heading: '' });
    expect(resolveRelativeMdHref('./x.md', 'dir/current.md')).toEqual({ path: 'dir/x.md', heading: '' });
  });

  it('clamps .. at the namespace root', () => {
    expect(resolveRelativeMdHref('../../../top.md', 'dir/current.md')).toEqual({ path: 'top.md', heading: '' });
  });

  it('splits off a heading fragment and decodes %20', () => {
    expect(resolveRelativeMdHref('My%20Note.md#Setup', 'current.md')).toEqual({ path: 'My Note.md', heading: 'Setup' });
  });

  it('ignores external, absolute, anchor and non-md hrefs', () => {
    expect(resolveRelativeMdHref('https://example.com/a.md', 'c.md')).toBe(null);
    expect(resolveRelativeMdHref('mailto:a@b.c', 'c.md')).toBe(null);
    expect(resolveRelativeMdHref('#section', 'c.md')).toBe(null);
    expect(resolveRelativeMdHref('/abs/path.md', 'c.md')).toBe(null);
    expect(resolveRelativeMdHref('image.png', 'c.md')).toBe(null);
  });
});

describe('relative .md links through marked', () => {
  const render = makeRenderer('projects/deep/notes.md');

  it('rewrites a relative .md link to an internal anchor', () => {
    const html = render('[the roadmap](../Roadmap.md)');
    expect(html).toContain('class="wikilink"');
    expect(html).toContain('data-path="projects/Roadmap.md"');
    expect(html).toContain('href="#work/projects/Roadmap.md"');
    expect(html).not.toContain('target="_blank"');
  });

  it('keeps external links external', () => {
    const html = render('[site](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('keeps non-md relative links on the existing behavior', () => {
    const html = render('[img](photo.png)');
    expect(html).not.toContain('class="wikilink"');
  });
});

describe('buildHashHref', () => {
  it('matches the app hash format with encoded segments', () => {
    expect(buildHashHref('work', 'a b/c.md')).toBe('#work/a%20b/c.md');
    expect(buildHashHref('', 'a.md')).toBe('#');
  });
});

describe('restoreWikilinks (Milkdown serializer unescape)', () => {
  it('restores escaped wikilink brackets', () => {
    expect(restoreWikilinks('See \\[\\[Target Note]].')).toBe('See [[Target Note]].');
  });

  it('unescapes punctuation inside the wikilink span only', () => {
    expect(restoreWikilinks('\\[\\[my\\_note\\_v2]] and \\_outside\\_')).toBe('[[my_note_v2]] and \\_outside\\_');
  });

  it('handles alias and heading forms', () => {
    expect(restoreWikilinks('\\[\\[dir/other#Heading|alias]]')).toBe('[[dir/other#Heading|alias]]');
  });

  it('is a no-op when there is nothing to restore', () => {
    expect(restoreWikilinks('plain text with [[real]] links')).toBe('plain text with [[real]] links');
    expect(restoreWikilinks('')).toBe('');
    expect(restoreWikilinks(null)).toBe(null);
  });
});
