import { useState, useEffect, useCallback, useMemo } from 'react';
import { getNoteHistory, getNoteAtCommit, getNote, restoreNote } from '../api.js';

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
  // Diff support: when compareTo is non-null, the right pane shows a unified
  // diff between `selected`'s content and `compareTo`'s content. compareTo
  // is either 'current' (the live working file via getNote) or another
  // commit object from `commits`. Default null = single-content view.
  const [compareTo, setCompareTo] = useState(null);
  const [compareContent, setCompareContent] = useState('');
  const [compareLoading, setCompareLoading] = useState(false);

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

  // Load comparison content when compareTo changes. 'current' fetches the
  // live note via getNote (no ref), so the diff reflects what restoring
  // `selected` would actually undo right now. A commit object fetches that
  // commit's content via getNoteAtCommit.
  useEffect(() => {
    if (!compareTo) { setCompareContent(''); return; }
    let cancelled = false;
    setCompareLoading(true);
    const p = compareTo === 'current'
      ? getNote(ns, path).then((r) => r.text)
      : getNoteAtCommit(ns, path, compareTo.commit);
    p.then((text) => { if (!cancelled) setCompareContent(text); })
      .catch((err) => { if (!cancelled) setCompareContent('(failed to load: ' + err.message + ')'); })
      .finally(() => { if (!cancelled) setCompareLoading(false); });
    return () => { cancelled = true; };
  }, [ns, path, compareTo]);

  // Recompute the unified diff whenever either side changes. Memoised
  // because diffLines is O(m*n) — fine for typical note files (a few KB)
  // but no need to redo it on every render.
  const diffRows = useMemo(() => {
    if (!compareTo || !preview || !compareContent) return null;
    return diffLines(preview, compareContent);
  }, [compareTo, preview, compareContent]);

  // Drop the comparison target if the user picks a new primary commit and
  // the comparison was that same commit — pointless to diff a commit
  // against itself.
  useEffect(() => {
    if (compareTo && compareTo !== 'current' && selected && compareTo.commit === selected.commit) {
      setCompareTo(null);
    }
  }, [selected, compareTo]);

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
              <>
                <div className="history-preview-header">
                  {compareTo ? (
                    <>
                      Diff: <strong>{selected.commit.slice(0, 7)}</strong>
                      {' '}({absoluteTime(selected.unix_ts)})
                      {' → '}
                      <strong>{compareTo === 'current' ? 'current' : compareTo.commit.slice(0, 7)}</strong>
                      {compareTo !== 'current' && ` (${absoluteTime(compareTo.unix_ts)})`}
                    </>
                  ) : (
                    <>Content as of <strong>{absoluteTime(selected.unix_ts)}</strong> ({selected.commit.slice(0, 7)})</>
                  )}
                  <div className="history-compare-row">
                    <label>Compare to:</label>
                    <select
                      value={compareTo === 'current' ? '__current' : (compareTo ? compareTo.commit : '')}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) setCompareTo(null);
                        else if (v === '__current') setCompareTo('current');
                        else {
                          const c = (commits || []).find((x) => x.commit === v);
                          if (c) setCompareTo(c);
                        }
                      }}
                    >
                      <option value="">— (show content)</option>
                      <option value="__current">Current version</option>
                      {(commits || [])
                        .filter((c) => !selected || c.commit !== selected.commit)
                        .map((c) => (
                          <option key={c.commit} value={c.commit}>
                            {c.commit.slice(0, 7)} — {relativeTime(c.unix_ts)}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
                {previewLoading || compareLoading ? (
                  <div className="admin-hint">Loading…</div>
                ) : compareTo && diffRows ? (
                  diffRows.length === 0 ? (
                    <div className="admin-hint">No differences — these versions are identical.</div>
                  ) : (
                    <pre className="history-content history-diff">
                      {diffRows.map((row, i) => (
                        <div key={i} className={`diff-row diff-${row.type}`}>
                          <span className="diff-marker">{row.type === 'add' ? '+' : row.type === 'del' ? '-' : ' '}</span>
                          <span className="diff-text">{row.text}</span>
                        </div>
                      ))}
                    </pre>
                  )
                ) : (
                  <pre className="history-content">{preview}</pre>
                )}
              </>
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

// diffLines returns a unified diff between two strings as an array of
// { type: 'same' | 'add' | 'del', text } rows. "del" lines exist only in
// `oldText`; "add" lines exist only in `newText`. Used in compare mode to
// show what restoring an older version would actually change vs current.
//
// LCS-based — O(m*n) time/space. Note files are typically a few KB / a few
// hundred lines, so this is fine. If a future use case lands a 10k-line
// file in here, swap in a Myers diff library.
function diffLines(oldText, newText) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  const m = oldLines.length;
  const n = newLines.length;
  // dp[i][j] = LCS length of oldLines[i..] and newLines[j..].
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      out.push({ type: 'same', text: oldLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: oldLines[i] });
      i++;
    } else {
      out.push({ type: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: 'del', text: oldLines[i++] });
  while (j < n) out.push({ type: 'add', text: newLines[j++] });
  // If the only rows are "same" (identical inputs), return [] so the UI
  // can show "no differences" rather than a blank diff pane.
  if (out.every((r) => r.type === 'same')) return [];
  return out;
}
