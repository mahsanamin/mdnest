import { useCallback, useEffect, useRef, useState } from 'react';
import { getApproval, decideApproval } from '../api.js';
import { APPROVAL_CARD_POLL_MS, MAX_DENY_REASON, stateText } from '../approvals.js';

// One agent approval request: which machine and agent ask, the exact command,
// the agent's own description (labelled as the agent's, because the model
// writes it and it can say anything), and Allow / Deny / Deny with a reason.
//
// Everything is rendered as React text, never as HTML, so nothing in a
// command or a description can become markup. The details come from
// GET /api/approvals/<id>, which answers only the owner account, so the
// buttons only ever show for the owner. A decision is accepted only from a
// browser login; the server refuses it with an API token.
//
// `initial` is the request as a list already has it (the approvals panel),
// so the card does not flash empty. In a chat the card loads it by id.
function ApprovalCard({ id, initial, onDecided }) {
  const [a, setA] = useState(initial || null);
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const v = await getApproval(id);
      if (alive.current) { setA(v); setMissing(false); }
    } catch (err) {
      if (alive.current && err.status === 404) setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  // Poll while it is still open: it can be answered in the terminal, expire,
  // or be decided from another tab.
  const pending = !missing && (!a || a.state === 'pending');
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(load, APPROVAL_CARD_POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  const decide = async (decision) => {
    setBusy(true);
    setError('');
    try {
      const v = await decideApproval(id, decision, decision === 'deny' ? reason.trim() : '');
      setA(v);
      setAsking(false);
      onDecided?.(v);
    } catch (err) {
      setError(err.message || 'Failed to send the decision');
    } finally {
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <div className="approval-card gone" data-testid="approval-card" data-state="gone">
        <div className="approval-card-state">This approval request is no longer available here.</div>
      </div>
    );
  }
  if (!a) {
    return <div className="approval-card loading" data-testid="approval-card" data-state="loading">Loading the approval request…</div>;
  }

  const who = a.agentName || a.agent;
  return (
    <div className={`approval-card ${a.state}`} data-testid="approval-card" data-state={a.state}>
      <div className="approval-card-head">
        <span className="approval-card-who">{who}{a.machine ? <> on <strong className="approval-card-machine">{a.machine}</strong></> : null}</span>
        <span className="approval-card-ask">asks to run{a.toolName && a.toolName !== 'Bash' ? ` (${a.toolName})` : ''}:</span>
      </div>
      <pre className="approval-card-command" data-testid="approval-command"><code>{a.command}</code></pre>
      {a.description && (
        <div className="approval-card-desc">
          <span className="approval-card-desc-label">The agent describes it as:</span> {a.description}
        </div>
      )}
      {a.cwd && <div className="approval-card-cwd">in <code>{a.cwd}</code></div>}
      {a.state === 'pending' ? (
        <div className="approval-card-actions">
          {!asking ? (
            <>
              <button type="button" className="approval-allow" disabled={busy} onClick={() => decide('allow')}>Allow</button>
              <button type="button" className="approval-deny" disabled={busy} onClick={() => decide('deny')}>Deny</button>
              <button type="button" className="approval-deny-reason" disabled={busy} onClick={() => setAsking(true)}>Deny with a reason</button>
            </>
          ) : (
            <form className="approval-card-reason" onSubmit={(e) => { e.preventDefault(); decide('deny'); }}>
              <input
                type="text"
                value={reason}
                maxLength={MAX_DENY_REASON}
                placeholder="Tell the agent why (it reads this)"
                aria-label="Reason for denying"
                autoFocus
                onChange={(e) => setReason(e.target.value)}
              />
              <button type="submit" className="approval-deny" disabled={busy}>Deny</button>
              <button type="button" className="approval-cancel" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
            </form>
          )}
          {error && <div className="approval-card-error" role="alert">{error}</div>}
        </div>
      ) : (
        <div className="approval-card-state" data-testid="approval-state">{stateText(a)}</div>
      )}
    </div>
  );
}

export default ApprovalCard;
