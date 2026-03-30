import { useState, useEffect, useCallback } from 'react';
import {
  adminListUsers,
  adminListGrants,
  adminCreateGrant,
  adminUpdateGrant,
  adminDeleteGrant,
} from '../api.js';

function ShareDialog({ namespace, path, onClose }) {
  const [grants, setGrants] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addUserId, setAddUserId] = useState('');
  const [addPermission, setAddPermission] = useState('write');
  const [error, setError] = useState('');

  const displayPath = path || '/';

  const loadGrants = useCallback(async () => {
    try {
      const data = await adminListGrants({ namespace, path: displayPath });
      setGrants(data);
    } catch (e) {
      console.error(e);
    }
  }, [namespace, displayPath]);

  useEffect(() => {
    Promise.all([
      adminListUsers().then(setUsers),
      loadGrants(),
    ]).finally(() => setLoading(false));
  }, [loadGrants]);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!addUserId) return;
    setError('');
    try {
      await adminCreateGrant(parseInt(addUserId), namespace, displayPath, addPermission);
      setAddUserId('');
      await loadGrants();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleTogglePermission = async (grant) => {
    const newPerm = grant.permission === 'write' ? 'read' : 'write';
    try {
      await adminUpdateGrant(grant.id, newPerm);
      await loadGrants();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleRevoke = async (grant) => {
    if (!confirm(`Remove ${grant.username}'s access to ${displayPath}?`)) return;
    try {
      await adminDeleteGrant(grant.id);
      await loadGrants();
    } catch (err) {
      setError(err.message);
    }
  };

  // Users who don't already have a grant at this exact path
  const grantedUserIds = new Set(grants.map((g) => g.user_id));
  const availableUsers = users.filter((u) => u.role === 'collaborator' && !grantedUserIds.has(u.id));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="share-header">
          <div>
            <h3>Manage Access</h3>
            <div className="share-path">
              <span className="share-ns">{namespace}</span>
              <span className="share-sep">/</span>
              <span>{displayPath === '/' ? '(entire namespace)' : displayPath}</span>
            </div>
          </div>
          <button className="modal-close-btn" onClick={onClose}>x</button>
        </div>

        {error && <div className="share-error">{error}</div>}

        <div className="share-body">
          {loading ? (
            <div className="share-loading">Loading...</div>
          ) : (
            <>
              {grants.length > 0 ? (
                <div className="share-grants">
                  {grants.map((g) => (
                    <div key={g.id} className="share-grant-row">
                      <div className="share-grant-user">
                        <div className="share-avatar" style={{ backgroundColor: '#89b4fa' }}>
                          {g.username.slice(0, 1).toUpperCase()}
                        </div>
                        <span className="share-username">{g.username}</span>
                      </div>
                      <div className="share-grant-actions">
                        <button
                          className={`share-perm-btn ${g.permission}`}
                          onClick={() => handleTogglePermission(g)}
                          title={`Click to switch to ${g.permission === 'write' ? 'read' : 'write'}`}
                        >
                          {g.permission === 'write' ? 'Can edit' : 'Can view'}
                        </button>
                        <button className="share-revoke-btn" onClick={() => handleRevoke(g)} title="Remove access">
                          x
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="share-empty">No one has specific access to this path yet.</div>
              )}

              {availableUsers.length > 0 && (
                <form className="share-add-form" onSubmit={handleAdd}>
                  <select value={addUserId} onChange={(e) => setAddUserId(e.target.value)}>
                    <option value="">Add a person...</option>
                    {availableUsers.map((u) => (
                      <option key={u.id} value={u.id}>{u.username} ({u.email})</option>
                    ))}
                  </select>
                  <select value={addPermission} onChange={(e) => setAddPermission(e.target.value)}>
                    <option value="write">Can edit</option>
                    <option value="read">Can view</option>
                  </select>
                  <button type="submit" disabled={!addUserId}>Share</button>
                </form>
              )}

              <div className="share-hint">
                Admins always have full access. Grants here apply to this specific {displayPath === '/' ? 'namespace' : 'directory'} and everything inside it.
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ShareDialog;
