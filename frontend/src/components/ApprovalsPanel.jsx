import ApprovalCard from './ApprovalCard.jsx';

// The approvals list: every request waiting for this account, from any chat
// or none, and the notices about agents that are stuck or stopped. Opened
// from the badge in the sidebar footer.
function ApprovalsPanel({ approvals, notices, onClose, onRefresh, onDismiss, notifyState, onEnableNotifications }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal approvals-panel" role="dialog" aria-label="Agent approvals" onClick={(e) => e.stopPropagation()}>
        <h3>Agent approvals</h3>
        {approvals.length === 0 && notices.length === 0 && <p className="approvals-empty">Nothing is waiting for you.</p>}
        <div className="approvals-list">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} id={a.id} initial={a} onDecided={onRefresh} />
          ))}
        </div>
        {notices.length > 0 && (
          <div className="approvals-notices">
            {notices.map((n) => (
              <div key={n.id} className={`approval-notice ${n.type}`} data-testid="approval-notice">
                <span className="approval-notice-text">{n.text}</span>
                {n.chat && <span className="approval-notice-chat">in {n.chat}</span>}
                <span className="approval-notice-time">
                  {new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
                <button type="button" className="approval-notice-dismiss" onClick={() => onDismiss(n.id)} aria-label={`Dismiss: ${n.text}`}>Dismiss</button>
              </div>
            ))}
          </div>
        )}
        {notifyState === 'default' && (
          <button type="button" className="approvals-notify" onClick={onEnableNotifications}>
            Notify me in this browser when an agent asks
          </button>
        )}
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default ApprovalsPanel;
