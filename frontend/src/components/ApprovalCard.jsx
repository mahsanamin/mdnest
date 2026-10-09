import { useCallback, useEffect, useRef, useState } from 'react';
import { getApproval, decideApproval } from '../api.js';
import {
  APPROVAL_CARD_POLL_MS, MAX_DENY_REASON, stateText, shortPath, tildePath, middleEllipsis,
  firstLines, answersComplete, toggleChoice,
} from '../approvals.js';

// One agent approval request: which agent asks (its chat name, kind and
// machine), what it wants to run or ask, and the buttons.
//
// Everything is rendered as React text, never as HTML, so nothing in a
// command, a file or a question can become markup. The details come from
// GET /api/approvals/<id>, which answers only the owner account, so the
// buttons only ever show for the owner. A decision is accepted only from a
// browser login; the server refuses it with an API token.
//
// `initial` is the request as a list already has it (the approvals panel),
// so the card does not flash empty. In a chat the card loads it by id.

// Long text the person must be able to read in full: a preview, and the rest
// on a tap, because what they approve is exactly what runs.
function Expandable({ text, className, testId }) {
  const [open, setOpen] = useState(false);
  const { shown, more } = firstLines(text);
  return (
    <>
      <pre className={className} data-testid={testId}><code>{open ? text : shown}</code></pre>
      {more > 0 && (
        <button type="button" className="approval-card-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `${more} more line${more === 1 ? '' : 's'} not shown`}
        </button>
      )}
    </>
  );
}

// A path or folder, shortened (see shortPath: never in a way that changes
// where it points), the full value one tap away. `ellipsis` cuts the middle on
// a narrow screen and is only used for context (the agent's folder), never
// for the file being approved, which wraps instead.
function PathLine({ full, short, ellipsis }) {
  const [open, setOpen] = useState(false);
  const shown = open ? full : (ellipsis ? middleEllipsis(short) : short);
  return (
    <button type="button" className="approval-card-path" title={full} onClick={() => setOpen(!open)}>
      <code>{shown}</code>
    </button>
  );
}

function ToolBody({ a }) {
  const d = a.details;
  if (d?.kind === 'write') {
    return (
      <>
        <div className="approval-card-file">Write <PathLine full={d.path} short={shortPath(d.path, a.cwd)} /></div>
        <Expandable text={d.content || ''} className="approval-card-command" testId="approval-command" />
      </>
    );
  }
  if (d?.kind === 'edit') {
    return (
      <>
        <div className="approval-card-file">Edit <PathLine full={d.path} short={shortPath(d.path, a.cwd)} />{d.replaceAll ? ' (every occurrence)' : ''}</div>
        <div className="approval-card-label">Replace</div>
        <Expandable text={d.oldString || ''} className="approval-card-command approval-card-old" testId="approval-old" />
        <div className="approval-card-label">with</div>
        <Expandable text={d.newString || ''} className="approval-card-command approval-card-new" testId="approval-new" />
      </>
    );
  }
  return <Expandable text={a.command} className="approval-card-command" testId="approval-command" />;
}

function QuestionForm({ a, busy, onAnswer }) {
  const [answers, setAnswers] = useState(() => a.questions.map(() => ({ selected: [], other: '' })));
  const set = (i, v) => setAnswers((cur) => cur.map((x, j) => (j === i ? v : x)));
  // A single question with single select sends on the first tap, as the
  // terminal does; anything else collects answers and sends with one button.
  const instant = a.questions.length === 1 && !a.questions[0].multiSelect;
  return (
    <div className="approval-questions">
      {a.questions.map((q, i) => (
        <fieldset key={i} className="approval-question" data-testid="approval-question">
          <legend>{q.header ? <span className="approval-question-header">{q.header}</span> : null}{q.question}</legend>
          <div className="approval-question-options">
            {q.options.map((o, k) => {
              const picked = answers[i].selected.includes(k);
              return q.multiSelect ? (
                <label key={k} className={`approval-option${picked ? ' picked' : ''}`} title={o.description || undefined}>
                  <input type="checkbox" checked={picked} disabled={busy} onChange={() => set(i, toggleChoice(q, answers[i], k))} />
                  {o.label}
                </label>
              ) : (
                <button key={k} type="button" disabled={busy} title={o.description || undefined}
                  className={`approval-option${picked ? ' picked' : ''}`}
                  onClick={() => {
                    const next = toggleChoice(q, answers[i], k);
                    set(i, next);
                    if (instant) onAnswer([next]);
                  }}>
                  {o.label}
                </button>
              );
            })}
          </div>
          <input type="text" className="approval-other" maxLength={MAX_DENY_REASON} disabled={busy}
            placeholder="Other: type your own answer" aria-label={`Other answer to: ${q.question}`}
            value={answers[i].other}
            onChange={(e) => set(i, q.multiSelect ? { ...answers[i], other: e.target.value } : { selected: [], other: e.target.value })} />
        </fieldset>
      ))}
      {(!instant || answers[0].other.trim()) && (
        <button type="button" className="approval-allow" disabled={busy || !answersComplete(a.questions, answers)}
          onClick={() => onAnswer(answers)}>
          Send
        </button>
      )}
    </div>
  );
}

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

  const decide = async (decision, answers) => {
    setBusy(true);
    setError('');
    try {
      const v = await decideApproval(id, decision, decision === 'deny' ? reason.trim() : '', answers);
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

  const isQuestion = Array.isArray(a.questions) && a.questions.length > 0;
  const who = a.label || a.agentName || a.agent;
  return (
    <div className={`approval-card ${a.state}${isQuestion ? ' question' : ''}`} data-testid="approval-card" data-state={a.state}>
      <div className="approval-card-head">
        <span className="approval-card-who">{who}</span>
        <span className="approval-card-ask">
          {isQuestion ? 'asks:' : `asks to run${a.toolName && a.toolName !== 'Bash' && !a.details ? ` (${a.toolName})` : ''}:`}
        </span>
      </div>
      {!isQuestion && <ToolBody a={a} />}
      {!isQuestion && a.description && (
        <div className="approval-card-desc">
          <span className="approval-card-desc-label">The agent describes it as:</span> {a.description}
        </div>
      )}
      {a.cwd && <div className="approval-card-cwd">in <PathLine full={a.cwd} short={tildePath(a.cwd, a.cwd)} ellipsis /></div>}
      {a.state === 'pending' ? (
        <div className="approval-card-actions">
          {isQuestion && !asking && <QuestionForm a={a} busy={busy} onAnswer={(answers) => decide('answer', answers)} />}
          {!asking ? (
            <>
              {!isQuestion && <button type="button" className="approval-allow" disabled={busy} onClick={() => decide('allow')}>Allow</button>}
              {!isQuestion && a.sessionScope?.length > 0 && (
                <button type="button" className="approval-allow-session" disabled={busy} onClick={() => decide('allow_session')}
                  title={`Until this agent session ends, also allow: ${a.sessionScope.join(', ')}`}>
                  Allow for this session
                </button>
              )}
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
          {!isQuestion && a.sessionScope?.length > 0 && !asking && (
            <div className="approval-card-scope">For this session also allows: {a.sessionScope.join(', ')}</div>
          )}
          {error && <div className="approval-card-error" role="alert">{error}</div>}
        </div>
      ) : (
        <div className="approval-card-state" data-testid="approval-state">
          {stateText(a)}
          {a.answer && <pre className="approval-card-answer">{a.answer}</pre>}
        </div>
      )}
    </div>
  );
}

export default ApprovalCard;
