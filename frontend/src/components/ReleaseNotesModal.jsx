import { useMemo } from 'react';
import { Marked } from 'marked';

// ReleaseNotesModal — surfaces what's new in the latest GitHub release of
// mdnest. The backend's updates checker fetches the release JSON once per
// 24h; this component just renders what's in `latestRelease` from
// /api/config so the user can decide whether they care to update.
//
// Markdown rendering uses a fresh Marked instance (gfm + breaks), separate
// from the note Preview renderer so it can't be affected by future changes
// to that pipeline. No raw HTML is rendered — release bodies always go
// through marked first, and links are forced to open in a new tab.
export default function ReleaseNotesModal({ release, runningVersion, onClose, onDismiss }) {
  const html = useMemo(() => {
    if (!release || !release.notes) return '';
    try {
      const inst = new Marked({ breaks: true, gfm: true });
      return inst.parse(release.notes);
    } catch {
      return '';
    }
  }, [release]);

  if (!release) return null;
  const title = release.name || `v${release.version}`;
  const published = release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal release-notes-modal" onClick={(e) => e.stopPropagation()}>
        <h3>What's new in {title}</h3>
        <div className="release-notes-meta">
          <span>You're on <strong>v{runningVersion}</strong></span>
          <span aria-hidden="true">→</span>
          <span>Latest: <strong>v{release.version}</strong>{published ? ` (${published})` : ''}</span>
        </div>

        {html ? (
          <div
            className="release-notes-body"
            // Render the markdown release body. marked output is the only
            // HTML that ends up here; release.notes is GitHub's release
            // body, which mdnest's release process controls.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="admin-hint">No release notes were published with this version.</div>
        )}

        <div className="admin-form-row" style={{ justifyContent: 'space-between', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onDismiss} title="Hide this notice until a newer version is released">
            Don't remind me about this version
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose}>Close</button>
            {release.url && (
              <a className="release-notes-link" href={release.url} target="_blank" rel="noopener noreferrer">
                View on GitHub →
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
