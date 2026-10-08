import { useEffect, useRef, useState } from 'react';
import { createNoteWithContent } from '../api.js';
import { parsePastedNote, suggestCopyName, joinPath, localLinks, formatBytes, CLIPBOARD_MAX_BYTES } from '../transfer.js';

// PasteModal — "Paste here": a new note from what is on the clipboard,
// usually a note copied with "Copy file contents", possibly on a different
// server. Plain text is accepted from anywhere.
//
// It is driven only by a real paste event (Ctrl/Cmd+V, or the phone's own
// Paste in the box). It never calls navigator.clipboard.readText(): that is
// unavailable on plain-HTTP installs and prompts for permission elsewhere,
// while a paste event works everywhere and only ever sees what the user chose
// to paste.
//
// The note is created with the ordinary POST /api/note, so this server's
// permissions, its never-overwrite 409 and its git commit all apply, and the
// server drops any note-ID marker. On a collision a "(copy)" name is offered,
// never applied without the user confirming it.
export default function PasteModal({ namespace, folder, onClose, onPasted }) {
  const [note, setNote] = useState(null); // {name, content}
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => { boxRef.current?.focus(); }, []);

  const accept = (text) => {
    const r = parsePastedNote(text);
    if (!r.ok) {
      setNote(null);
      setMessage(r.reason === 'too_large'
        ? `That note is ${formatBytes(r.bytes)}, over the ${formatBytes(CLIPBOARD_MAX_BYTES)} clipboard limit. Download it on the other mdnest instead and add the file here.`
        : 'The clipboard is empty. Copy a note first (right-click it, Copy file contents).');
      return;
    }
    setNote(r);
    setName(r.name);
    setConflict(false);
    const links = localLinks(r.content);
    setMessage(links.length
      ? `This note links to ${links.length} file${links.length === 1 ? '' : 's'} on its own server (${links.slice(0, 3).join(', ')}${links.length > 3 ? ', …' : ''}). Those were not copied.`
      : '');
  };

  const onPaste = (e) => {
    e.preventDefault();
    accept(e.clipboardData?.getData('text/plain') || '');
  };

  const create = async () => {
    const target = joinPath(folder, name.trim());
    if (!note || !name.trim()) return;
    setBusy(true);
    try {
      const r = await createNoteWithContent(namespace, target, note.content);
      if (r.status === 201 || r.status === 200) {
        onPasted?.(target);
        return;
      }
      if (r.status === 409) {
        const suggestion = suggestCopyName(name.trim());
        setConflict(true);
        setMessage(`"${target}" already exists. Nothing was overwritten. Create it as "${suggestion}" instead?`);
        setName(suggestion);
      } else if (r.status === 403) {
        setMessage('You do not have write access here.');
      } else {
        setMessage(r.body?.error || `Failed (${r.status}).`);
      }
    } catch (e) {
      setMessage(e.message || 'Failed');
    }
    setBusy(false);
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal moveto-modal" onClick={(e) => e.stopPropagation()} data-testid="paste-modal">
        <h3>Paste here</h3>
        <div className="moveto-source">
          Into: <code>{namespace}:{folder ? folder.replace(/^\/+/, '') : '/'}</code>
        </div>
        {!note && (
          <textarea
            ref={boxRef}
            className="paste-capture"
            placeholder="Press Ctrl+V (⌘V on a Mac), or long-press here and choose Paste."
            value=""
            onPaste={onPaste}
            // Some phone keyboards insert text without a paste event.
            onChange={(e) => { if (e.target.value) accept(e.target.value); }}
            aria-label="Paste the copied note here"
            data-testid="paste-capture"
          />
        )}
        {note && (
          <>
            <label className="moveto-field">
              <span>Name</span>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setConflict(false); }}
                className={conflict ? 'conflict' : ''}
                disabled={busy}
                data-testid="paste-name"
              />
            </label>
            <div className="moveto-source">{note.content.length.toLocaleString()} characters</div>
          </>
        )}
        {message && <div className={`moveto-check ${note && !conflict ? 'moveto-check-warn' : 'moveto-check-refused'}`} role="status" data-testid="paste-message">{message}</div>}
        <div className="moveto-actions">
          <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          <button
            type="button"
            className="primary"
            onClick={create}
            disabled={busy || !note || !name.trim()}
            data-testid="paste-confirm"
          >
            {busy ? 'Creating…' : 'Create note'}
          </button>
        </div>
      </div>
    </div>
  );
}
