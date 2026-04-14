import { useRef, useCallback, useState, useEffect } from 'react';
import { uploadImage } from '../api.js';
import { htmlToMarkdown, hasRichContent } from '../html-to-md.js';
import EditorToolbar from './EditorToolbar.jsx';

function Editor({ content, onChange, currentPath, ns, readOnly, onCursorChange, onSelectionChange, remoteCursors }) {
  const textareaRef = useRef(null);

  const getSelection = () => {
    const ta = textareaRef.current;
    if (!ta) return { start: 0, end: 0, selected: '', before: '', after: '' };
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    return {
      start,
      end,
      selected: content.substring(start, end),
      before: content.substring(0, start),
      after: content.substring(end),
    };
  };

  const replaceAndFocus = (newContent, cursorPos) => {
    onChange(newContent);
    const ta = textareaRef.current;
    if (ta) {
      requestAnimationFrame(() => {
        ta.focus();
        ta.selectionStart = ta.selectionEnd = cursorPos;
      });
    }
  };

  const wrapSelection = (prefix, suffix) => {
    const { start, end, selected, before, after } = getSelection();
    const wrapped = prefix + (selected || 'text') + suffix;
    replaceAndFocus(before + wrapped + after, start + prefix.length + (selected ? selected.length : 4));
  };

  const insertAtLineStart = (prefix) => {
    const { start, before, after, selected } = getSelection();
    // Find start of current line
    const lineStart = before.lastIndexOf('\n') + 1;
    const beforeLine = content.substring(0, lineStart);
    const lineContent = selected || '';
    const afterContent = content.substring(start);
    replaceAndFocus(beforeLine + prefix + content.substring(lineStart), lineStart + prefix.length);
  };

  const insertBlock = (text) => {
    const { start, before, after } = getSelection();
    const needNewlineBefore = before.length > 0 && !before.endsWith('\n') ? '\n' : '';
    const needNewlineAfter = after.length > 0 && !after.startsWith('\n') ? '\n' : '';
    const block = needNewlineBefore + text + needNewlineAfter;
    replaceAndFocus(before + block + after, start + block.length - needNewlineAfter.length);
  };

  const handleFormat = useCallback((action) => {
    switch (action) {
      case 'bold': wrapSelection('**', '**'); break;
      case 'italic': wrapSelection('*', '*'); break;
      case 'strike': wrapSelection('~~', '~~'); break;
      case 'code': wrapSelection('`', '`'); break;
      case 'h1': insertAtLineStart('# '); break;
      case 'h2': insertAtLineStart('## '); break;
      case 'h3': insertAtLineStart('### '); break;
      case 'quote': insertAtLineStart('> '); break;
      case 'ul': insertAtLineStart('- '); break;
      case 'ol': insertAtLineStart('1. '); break;
      case 'task': insertAtLineStart('- [ ] '); break;
      case 'hr': insertBlock('\n---\n'); break;
      case 'link': wrapSelection('[', '](url)'); break;
      case 'image': wrapSelection('![', '](url)'); break;
      case 'codeblock': insertBlock('\n```\n\n```\n'); break;
      case 'mermaid': insertBlock('\n```mermaid\ngraph TD;\n    A-->B;\n```\n'); break;
    }
  }, [content]);

  const insertAtCursor = useCallback((text) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = content.substring(0, start);
    const after = content.substring(end);
    onChange(before + text + after);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + text.length;
      ta.focus();
    });
  }, [content, onChange]);

  const handleUpload = useCallback(async (file) => {
    if (!file || !file.type.startsWith('image/')) return;
    try {
      const data = await uploadImage(ns, currentPath, file);
      const filename = (data.url || file.name).split('/').pop();
      insertAtCursor(`![image](${filename})`);
    } catch (e) {
      console.error('Upload failed:', e);
    }
  }, [ns, currentPath, insertAtCursor]);

  const emitCursor = useCallback(() => {
    if (!onCursorChange && !onSelectionChange) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const before = content.substring(0, start);
    const line = before.split('\n').length - 1;
    const ch = start - before.lastIndexOf('\n') - 1;
    if (start === end) {
      if (onCursorChange) onCursorChange(line, ch);
    } else {
      const beforeEnd = content.substring(0, end);
      const endLine = beforeEnd.split('\n').length - 1;
      const endCh = end - beforeEnd.lastIndexOf('\n') - 1;
      if (onSelectionChange) onSelectionChange(line, ch, endLine, endCh);
    }
  }, [content, onCursorChange, onSelectionChange]);

  const handleKeyDown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.target;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const before = content.substring(0, start);
      const after = content.substring(end);
      onChange(before + '  ' + after);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
    }
  };

  const handlePaste = (e) => {
    const clipboard = e.clipboardData;
    if (!clipboard) return;

    // Check for images first
    for (const item of clipboard.items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleUpload(file);
        return;
      }
    }

    // Check for rich HTML content (from Google Docs, Confluence, etc.)
    // But NOT if the plain text already looks like markdown — the user is
    // pasting raw .md content and the HTML version would mangle it
    // (e.g. wrapping everything in triple backticks from <pre><code>).
    const html = clipboard.getData('text/html');
    const plain = clipboard.getData('text/plain');
    const looksLikeMarkdown = plain && /^[\s]*[#\-*>|`\[!]/.test(plain);
    if (html && hasRichContent(html) && !looksLikeMarkdown) {
      e.preventDefault();
      const md = htmlToMarkdown(html);
      insertAtCursor(md);
    }
    // Otherwise: default paste behavior (plain text)
  };

  const handleDrop = (e) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (const file of files) {
      if (file.type.startsWith('image/')) { handleUpload(file); return; }
    }
  };

  // Track scroll position for cursor overlay
  const [scrollTop, setScrollTop] = useState(0);
  const [lineHeight, setLineHeight] = useState(0);
  const [textareaRect, setTextareaRect] = useState(null);

  // Measure line height on mount and content change
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const style = window.getComputedStyle(ta);
    const lh = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
    setLineHeight(lh);
  }, [content]);

  const handleScroll = useCallback((e) => {
    setScrollTop(e.target.scrollTop);
  }, []);

  // Update textarea rect on resize
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const updateRect = () => setTextareaRect(ta.getBoundingClientRect());
    updateRect();
    const observer = new ResizeObserver(updateRect);
    observer.observe(ta);
    return () => observer.disconnect();
  }, []);

  // Compute cursor positions for remote cursors
  const cursorOverlays = remoteCursors ? Object.entries(remoteCursors).map(([userId, cursor]) => {
    if (!cursor || !lineHeight) return null;
    const line = cursor.line || 0;
    const ta = textareaRef.current;
    if (!ta) return null;
    const style = window.getComputedStyle(ta);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const top = paddingTop + (line * lineHeight) - scrollTop;
    // Don't render if scrolled out of view
    if (top < -lineHeight || top > ta.clientHeight) return null;
    return {
      userId: parseInt(userId),
      username: cursor.username,
      color: cursor.color,
      top,
    };
  }).filter(Boolean) : [];

  return (
    <div className="editor-pane">
      {!readOnly && <EditorToolbar onFormat={handleFormat} />}
      {readOnly && <div className="editor-readonly-bar">Read-only</div>}
      <div className="editor-container">
        <textarea
          ref={textareaRef}
          className="editor-textarea"
          value={content}
          onChange={readOnly ? undefined : (e) => onChange(e.target.value)}
          onKeyDown={readOnly ? undefined : handleKeyDown}
          onPaste={readOnly ? undefined : handlePaste}
          onDrop={readOnly ? undefined : handleDrop}
          onDragOver={readOnly ? undefined : (e) => e.preventDefault()}
          placeholder={readOnly ? '' : 'Start writing...'}
          spellCheck={false}
          readOnly={readOnly}
          onClick={emitCursor}
          onKeyUp={emitCursor}
          onSelect={emitCursor}
          onScroll={handleScroll}
        />
        {cursorOverlays.length > 0 && (
          <div className="cursor-overlay">
            {cursorOverlays.map((c) => (
              <div
                key={c.userId}
                className="remote-cursor"
                style={{ top: `${c.top}px`, borderColor: c.color }}
              >
                <span className="remote-cursor-label" style={{ backgroundColor: c.color }}>
                  {c.username}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default Editor;
