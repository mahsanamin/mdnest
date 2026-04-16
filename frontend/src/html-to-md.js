// Lightweight HTML-to-Markdown converter for clipboard paste.
// Handles the common elements from Google Docs, Confluence, Notion, etc.

export function htmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return convertNode(doc.body).trim().replace(/\n{3,}/g, '\n\n');
}

function convertNode(node) {
  let result = '';
  for (const child of node.childNodes) {
    result += convertSingle(child);
  }
  return result;
}

function convertSingle(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent.replace(/\n\s*/g, ' ');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const tag = node.tagName.toLowerCase();
  const inner = () => convertNode(node);

  switch (tag) {
    // Headings
    case 'h1': return `\n# ${inner().trim()}\n\n`;
    case 'h2': return `\n## ${inner().trim()}\n\n`;
    case 'h3': return `\n### ${inner().trim()}\n\n`;
    case 'h4': return `\n#### ${inner().trim()}\n\n`;
    case 'h5': return `\n##### ${inner().trim()}\n\n`;
    case 'h6': return `\n###### ${inner().trim()}\n\n`;

    // Inline formatting
    case 'strong':
    case 'b': {
      const text = inner().trim();
      return text ? `**${text}**` : '';
    }
    case 'em':
    case 'i': {
      const text = inner().trim();
      return text ? `*${text}*` : '';
    }
    case 'u': return inner(); // no markdown underline, just pass through
    case 's':
    case 'strike':
    case 'del': {
      const text = inner().trim();
      return text ? `~~${text}~~` : '';
    }
    case 'code': return `\`${inner().trim()}\``;
    case 'mark': return inner(); // highlight — no standard markdown

    // Links
    case 'a': {
      const href = node.getAttribute('href') || '';
      const text = inner().trim();
      if (!href || href.startsWith('javascript:')) return text;
      return text === href ? `<${href}>` : `[${text}](${href})`;
    }

    // Images
    case 'img': {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || 'image';
      return src ? `![${alt}](${src})` : '';
    }

    // Block elements
    case 'p':
    case 'div': {
      const text = inner().trim();
      return text ? `\n${text}\n` : '\n';
    }
    case 'br': return '\n';
    case 'hr': return '\n---\n';

    // Blockquote
    case 'blockquote': {
      const lines = inner().trim().split('\n');
      return '\n' + lines.map((l) => `> ${l}`).join('\n') + '\n';
    }

    // Pre / code blocks
    case 'pre': {
      const codeEl = node.querySelector('code');
      const text = codeEl ? codeEl.textContent : node.textContent;
      const lang = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
      return `\n\`\`\`${lang}\n${text.trim()}\n\`\`\`\n`;
    }

    // Lists
    case 'ul':
    case 'ol': return '\n' + convertList(node, tag === 'ol') + '\n';
    case 'li': return inner(); // handled by convertList

    // Tables
    case 'table': return '\n' + convertTable(node) + '\n';
    case 'thead':
    case 'tbody':
    case 'tfoot':
    case 'tr':
    case 'th':
    case 'td': return inner(); // handled by convertTable

    // Spans (Google Docs wraps everything in spans)
    case 'span': return inner();

    // Skip script, style, etc.
    case 'script':
    case 'style':
    case 'meta':
    case 'link': return '';

    // Default: just process children
    default: return inner();
  }
}

function convertList(node, ordered, depth = 0) {
  const items = [];
  const indent = '  '.repeat(depth);
  let counter = 1;

  for (const child of node.children) {
    if (child.tagName?.toLowerCase() !== 'li') continue;

    let text = '';
    let sublist = '';

    for (const liChild of child.childNodes) {
      const tag = liChild.tagName?.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        sublist += convertList(liChild, tag === 'ol', depth + 1);
      } else {
        text += convertSingle(liChild);
      }
    }

    text = text.trim().replace(/\n+/g, ' ');

    // Check for checkbox
    const checkbox = child.querySelector('input[type="checkbox"]');
    if (checkbox) {
      const checked = checkbox.checked ? 'x' : ' ';
      text = text.replace(/^\s*/, '');
      items.push(`${indent}- [${checked}] ${text}`);
    } else {
      const prefix = ordered ? `${counter}.` : '-';
      items.push(`${indent}${prefix} ${text}`);
      counter++;
    }

    if (sublist) items.push(sublist);
  }

  return items.join('\n');
}

function convertTable(tableNode) {
  const rows = [];
  for (const tr of tableNode.querySelectorAll('tr')) {
    const cells = [];
    for (const cell of tr.querySelectorAll('th, td')) {
      cells.push(convertNode(cell).trim().replace(/\n/g, ' ').replace(/\|/g, '\\|'));
    }
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  const colCount = Math.max(...rows.map((r) => r.length));
  const padded = rows.map((r) => {
    while (r.length < colCount) r.push('');
    return r;
  });

  const lines = [];
  lines.push('| ' + padded[0].join(' | ') + ' |');
  lines.push('| ' + padded[0].map(() => '---').join(' | ') + ' |');
  for (let i = 1; i < padded.length; i++) {
    lines.push('| ' + padded[i].join(' | ') + ' |');
  }

  return lines.join('\n');
}

// Quick check: does this HTML have any meaningful structure worth converting?
export function hasRichContent(html) {
  return /<(h[1-6]|strong|b|em|i|a |ul|ol|table|pre|blockquote|code)/i.test(html);
}
