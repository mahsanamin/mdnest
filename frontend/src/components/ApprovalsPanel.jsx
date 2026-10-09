import ApprovalCard from './ApprovalCard.jsx';

// The approvals list: every request waiting for this account, from any chat
// or none. Opened from the badge in the sidebar footer.
function ApprovalsPanel({ approvals, onClose, onRefresh, notifyState, onEnableNotifications }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal approvals-panel" role="dialog" aria-label="Agent approvals" onClick={(e) => e.stopPropagation()}>
        <h3>Agent approvals</h3>
        {approvals.length === 0 && <p className="approvals-empty">Nothing is waiting for you.</p>}
        <div className="approvals-list">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} id={a.id} initial={a} onDecided={onRefresh} />
          ))}
        </div>
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
