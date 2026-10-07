import { useState } from 'react';
import { emptyNamespacesMessage, emptyNamespacesFix } from '../emptyNamespaces';
import { copyPlainText } from '../mermaid-text';
import { grantSelfAllNamespaces } from '../api';

// The page shown when there are no namespaces (GitHub issue #123). It says why,
// and offers what can be done from here: an admin with no grants can give
// themselves access in one click, and a mount problem gets the exact lines to
// paste plus "Check again", so nobody has to reload or guess whether a fix on
// the server worked. Mounts themselves can only change on the server.
export default function EmptyNamespaces({ reason, isAdmin, isMulti, userId, onRecheck }) {
  const m = emptyNamespacesMessage(reason, { isAdmin });
  const fix = emptyNamespacesFix(reason, { isAdmin, isMulti });
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const recheck = async () => {
    setBusy('check');
    setNote('');
    try {
      const names = await onRecheck();
      if (!names || names.length === 0) setNote('Still no namespaces. The message above is up to date.');
    } finally {
      setBusy('');
    }
  };

  const grantSelf = async () => {
    setBusy('grant');
    setNote('');
    try {
      const { granted } = await grantSelfAllNamespaces(userId);
      const names = await onRecheck();
      if (!names || names.length === 0) {
        setNote(granted ? 'Access was granted, but no namespace is visible yet. Try Check again.' : 'There are no namespaces you can administer.');
      }
    } catch (e) {
      setNote(e.message || 'Could not grant access.');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="empty-namespaces" data-testid="empty-namespaces">
      <p><strong>{m.title}</strong></p>
      <p>{m.detail}</p>
      {fix.compose && (
        <>
          <Snippet label="docker-compose.yml, on the backend service" text={fix.compose} />
          <Snippet label="or, with setup.sh: add to mdnest.conf, then run ./mdnest-server reload" text={fix.setupConf} />
        </>
      )}
      <div className="empty-namespaces-actions">
        {fix.grantSelf && (
          <button type="button" className="empty-namespaces-primary" onClick={grantSelf} disabled={!!busy || !userId}>
            {busy === 'grant' ? 'Granting…' : 'Give me access to all namespaces'}
          </button>
        )}
        <button type="button" onClick={recheck} disabled={!!busy}>
          {busy === 'check' ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {note && <p className="empty-namespaces-note" role="status">{note}</p>}
    </div>
  );
}

function Snippet({ label, text }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (copyPlainText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="empty-namespaces-snippet">
      <div className="empty-namespaces-snippet-head">
        <span>{label}</span>
        <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}
