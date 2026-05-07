import { useState, useEffect, useCallback } from 'react';
import { getNoteHistory, getNoteAtCommit, restoreNote } from '../api.js';

// HistoryModal — view per-file git-sync history and (optionally) restore
// an older version. Reads from GET /api/note/history, displays the most
// recent 50 commits affecting the file, lets the user preview content at
// each commit, and writes a chosen older version back through the normal
// saveNote() path (which goes through the empty-overwrite guard, ETag
// conflict detection, and websocket file-changed broadcast — restore is
// not a separate write path).
//
// Single mode + multi mode work identically. The presence indicator and
// confirm-dialog wording adapt based on whether other users are on the
// same file (passed in via the otherUserNames prop).
export default function HistoryModal({
  ns,
  path,
  currentETag,
  canWrite,
  otherUserNames,
  onClose,
  onRestored,
}) {
  const [commits, setCommits] = useState(null); // null = loading, [] = no history
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null); // commit object
  const [preview, setPreview] = useState(''); // content at selected commit
  const [previewLoading, setPreviewLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);

  // Load the commit list once when the modal opens.
  useEffect(() => {
    let cancelled = false;
    getNoteHistory(ns, path)
      .then((rows) => {
        if (cancelled) return;
        if (rows === null) {
          setError('git-sync is not configured for this namespace. Set up git-sync to track per-file history.');
          setCommits([]);
        } else {
          setCommits(rows);
          if (rows.length > 0) setSelected(rows[0]); // default-select most recent
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setCommits([]);
      });
    return () => { cancelled = true; };
  }, [ns, path]);

  // Load preview content whenever the user selects a commit.
  useEffect(() => {
    if (!selected) { setPreview(''); return; }
    let cancelled = false;
    setPreviewLoading(true);
    getNoteAtCommit(ns, path, selected.commit)
      .then((text) => { if (!cancelled) setPreview(text); })
      .catch((err) => { if (!cancelled) setPreview('(failed to load: ' + err.message + ')'); })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [ns, path, selected]);

  const handleRestore = useCallback(async () => {
    if (!selected) return;
    const others = otherUserNames || [];
    const msg = others.length > 0
      ? `${others.join(', ')} ${others.length === 1 ? 'is' : 'are'} also viewing this file. Restoring will replace the current content for everyone (their unsaved local edits, if any, are kept until they choose to reload). Continue?`
      : 'Restore this version? The current content will be overwritten — but git-sync keeps the full history, so this is itself reversible from this same modal.';
    if (!window.confirm(msg)) return;

    setRestoring(true);
    setError('');
    try {
      const content = await getNoteAtCommit(ns, path, selected.commit);
      await restoreNote(ns, path, selected.commit, content, currentETag);
      onRestored(content);
    } catch (err) {
      if (err.status === 409) {
        setError('Someone else just saved this file. Close this modal, reload the note, and try again.');
      } else {
        setError(err.message);
      }
      setRestoring(false);
    }
  }, [ns, path, selected, otherUserNames, currentETag, onRestored]);

  const filename = path.split('/').pop();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal history-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Version history — <code>{filename}</code></h3>

        {error && <div className="admin-error">{error}</div>}

        <div className="history-body">
          <div className="history-list">
            {commits === null && <div className="admin-hint">Loading…</div>}
            {commits !== null && commits.length === 0 && !error && (
              <div className="admin-hint">No history yet — git-sync hasn't committed this file.</div>
            )}
            {commits !== null && commits.map((c) => (
              <button
                key={c.commit}
                type="button"
                className={`history-commit-item${selected && selected.commit === c.commit ? ' selected' : ''}`}
                onClick={() => setSelected(c)}
              >
                <div className="history-commit-when">{relativeTime(c.unix_ts)}</div>
                <div className="history-commit-meta">
                  <span className="history-commit-author">{c.author}</span>
                  <code className="history-commit-sha">{c.commit.slice(0, 7)}</code>
                </div>
                {c.message && <div className="history-commit-msg" title={c.message}>{c.message}</div>}
              </button>
            ))}
          </div>

          <div className="history-preview">
            {selected ? (
              previewLoading ? (
                <div className="admin-hint">Loading preview…</div>
              ) : (
                <>
                  <div className="history-preview-header">
                    Content as of <strong>{absoluteTime(selected.unix_ts)}</strong> ({selected.commit.slice(0, 7)})
                  </div>
                  <pre className="history-content">{preview}</pre>
                </>
              )
            ) : (
              <div className="admin-hint">Select a commit on the left to preview its content.</div>
            )}
          </div>
        </div>

        {(otherUserNames && otherUserNames.length > 0) && (
          <div className="admin-hint history-presence">
            {otherUserNames.join(', ')} {otherUserNames.length === 1 ? 'is' : 'are'} also viewing this file right now.
          </div>
        )}

        <div className="admin-form-row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onClose} disabled={restoring}>Close</button>
          <button
            type="button"
            onClick={handleRestore}
            disabled={!selected || !canWrite || restoring}
            title={!canWrite ? 'You have read-only access to this file' : ''}
          >
            {restoring ? 'Restoring…' : 'Restore this version'}
          </button>
        </div>
      </div>
    </div>
  );
}

function relativeTime(unixTs) {
  const now = Date.now() / 1000;
  const diff = now - unixTs;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(unixTs * 1000).toLocaleDateString();
}

function absoluteTime(unixTs) {
  return new Date(unixTs * 1000).toLocaleString();
}
