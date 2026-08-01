import { useState, useEffect } from 'react';
import { getNoteAttribution } from '../api.js';

// AttributionModal — mdnest's internal "blame": who created, last edited, and
// contributed to a note. Reads GET /api/note/attribution, which is backed by
// the per-save authorship trail rather than git blame (git commits are made by
// a bot identity and a single commit can aggregate several people's edits).
//
// Attribution is by who *saved* each version — in live collaboration a save can
// carry text typed by several people, so this is deliberately framed as savers,
// not per-keystroke authorship. The endpoint is multi-mode only; in single mode
// (or when it 404s) the modal degrades to a clear message.
export default function AttributionModal({ ns, path, onClose }) {
  const [data, setData] = useState(undefined); // undefined = loading, null = unavailable
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    getNoteAttribution(ns, path)
      .then((d) => {
        if (!cancelled) setData(d); // d may be null (endpoint unavailable)
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load authorship.');
      });
    return () => {
      cancelled = true;
    };
  }, [ns, path]);

  const filename = path.split('/').pop();
  const hasAny = data && (data.created || data.last_edited || (data.contributors && data.contributors.length));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal attribution-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Authors — <code>{filename}</code></h3>

        {error && <div className="admin-error">{error}</div>}

        {data === undefined && !error && <div className="admin-hint">Loading…</div>}

        {data === null && !error && (
          <div className="admin-hint">
            Authorship tracking isn't available for this workspace. It records who
            created and edited each note in multi-user mode.
          </div>
        )}

        {data && !hasAny && !error && (
          <div className="admin-hint">No saves recorded yet for this note.</div>
        )}

        {data && hasAny && (
          <>
            <div className="attribution-summary">
              {data.created && (
                <div className="attribution-row">
                  <span className="attribution-label">Created by</span>
                  <span className="attribution-user">{data.created.username}</span>
                  <span className="attribution-when" title={data.created.at}>{formatWhen(data.created.at)}</span>
                </div>
              )}
              {data.last_edited && (
                <div className="attribution-row">
                  <span className="attribution-label">Last edited by</span>
                  <span className="attribution-user">{data.last_edited.username}</span>
                  <span className="attribution-when" title={data.last_edited.at}>{formatWhen(data.last_edited.at)}</span>
                </div>
              )}
            </div>

            {data.contributors && data.contributors.length > 0 && (
              <div className="attribution-contributors">
                <div className="attribution-label">Contributors</div>
                <div className="attribution-chips">
                  {data.contributors.map((c) => (
                    <span key={c.user_id} className="attribution-chip" title={c.at ? `last saved ${formatWhen(c.at)}` : ''}>
                      {c.username}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="admin-hint attribution-note">
              Attribution is by who saved each version. In live collaboration a
              single save can include edits from more than one person.
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// formatWhen renders an ISO-8601 timestamp as a short absolute date, falling
// back to the raw value if it doesn't parse.
function formatWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
