import { useState, useEffect, useCallback } from 'react';
import {
  adminListUsers,
  adminInviteUser,
  adminDeleteUser,
  adminUpdateRole,
  adminListGrants,
  adminCreateGrant,
  adminUpdateGrant,
  adminDeleteGrant,
} from '../api.js';

function AdminPanel({ onClose, namespaces }) {
  const [tab, setTab] = useState('users');

  return (
    <div className="admin-panel">
      <div className="admin-header">
        <h2>Admin Panel</h2>
        <button className="admin-close" onClick={onClose}>Back to notes</button>
      </div>
      <div className="admin-tabs">
        <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
        <button className={tab === 'grants' ? 'active' : ''} onClick={() => setTab('grants')}>Access Grants</button>
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'grants' && <GrantsTab namespaces={namespaces} />}
    </div>
  );
}

function UsersTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminListUsers();
      setUsers(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (user) => {
    if (!confirm(`Delete user "${user.username}"? Their access grants will also be removed.`)) return;
    try {
      await adminDeleteUser(user.id);
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  const handleToggleRole = async (user) => {
    const newRole = user.role === 'admin' ? 'collaborator' : 'admin';
    if (!confirm(`Change ${user.username}'s role to ${newRole}?`)) return;
    try {
      await adminUpdateRole(user.id, newRole);
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  if (loading) return <div className="admin-section">Loading...</div>;

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>Users ({users.length})</h3>
        <button onClick={() => setShowInvite(!showInvite)}>
          {showInvite ? 'Cancel' : '+ Invite User'}
        </button>
      </div>

      {showInvite && <InviteForm onDone={() => { setShowInvite(false); load(); }} />}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Role</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td>{u.email}</td>
              <td>
                <span className={`role-badge ${u.role}`}>{u.role}</span>
              </td>
              <td>{new Date(u.created_at).toLocaleDateString()}</td>
              <td>
                <button className="admin-action-btn" onClick={() => handleToggleRole(u)} title={`Change to ${u.role === 'admin' ? 'collaborator' : 'admin'}`}>
                  {u.role === 'admin' ? 'Demote' : 'Promote'}
                </button>
                <button className="admin-action-btn danger" onClick={() => handleDelete(u)} title="Delete user">
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InviteForm({ onDone }) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('collaborator');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await adminInviteUser(email, username, password, role);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="admin-invite-form" onSubmit={handleSubmit}>
      {error && <div className="admin-error">{error}</div>}
      <div className="admin-form-row">
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required />
      </div>
      <div className="admin-form-row">
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="collaborator">Collaborator</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <button type="submit" disabled={loading}>{loading ? 'Inviting...' : 'Invite'}</button>
    </form>
  );
}

function GrantsTab({ namespaces }) {
  const [users, setUsers] = useState([]);
  const [grants, setGrants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedUser, setExpandedUser] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      const [u, g] = await Promise.all([adminListUsers(), adminListGrants({})]);
      setUsers(u);
      setGrants(g);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { loadAll().finally(() => setLoading(false)); }, [loadAll]);

  const collaborators = users.filter((u) => u.role === 'collaborator');

  // Group grants by user_id
  const grantsByUser = {};
  for (const g of grants) {
    if (!grantsByUser[g.user_id]) grantsByUser[g.user_id] = [];
    grantsByUser[g.user_id].push(g);
  }

  const handleToggle = async (grant) => {
    const newPerm = grant.permission === 'write' ? 'read' : 'write';
    try {
      await adminUpdateGrant(grant.id, newPerm);
      await loadAll();
    } catch (err) { alert(err.message); }
  };

  const handleRevoke = async (grant) => {
    try {
      await adminDeleteGrant(grant.id);
      await loadAll();
    } catch (err) { alert(err.message); }
  };

  if (loading) return <div className="admin-section">Loading...</div>;

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>Access Grants</h3>
      </div>

      {collaborators.length === 0 ? (
        <div className="admin-hint">No collaborators yet. Invite a user first from the Users tab.</div>
      ) : (
        <div className="grants-user-list">
          {collaborators.map((user) => {
            const userGrants = grantsByUser[user.id] || [];
            const isExpanded = expandedUser === user.id;
            return (
              <div key={user.id} className={`grants-user-card${isExpanded ? ' expanded' : ''}`}>
                <div className="grants-user-header" onClick={() => setExpandedUser(isExpanded ? null : user.id)}>
                  <div className="grants-user-info">
                    <div className="grants-user-avatar">{user.username.slice(0, 1).toUpperCase()}</div>
                    <div>
                      <div className="grants-user-name">{user.username}</div>
                      <div className="grants-user-email">{user.email}</div>
                    </div>
                  </div>
                  <div className="grants-user-summary">
                    {userGrants.length > 0 ? (
                      <span className="grants-count">{userGrants.length} grant{userGrants.length !== 1 ? 's' : ''}</span>
                    ) : (
                      <span className="grants-none">No access</span>
                    )}
                    <span className="grants-chevron">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                  </div>
                </div>

                {isExpanded && (
                  <div className="grants-user-body">
                    {userGrants.length > 0 && (
                      <div className="grants-list">
                        {userGrants.map((g) => (
                          <div key={g.id} className="grants-item">
                            <div className="grants-item-path">
                              <span className="grants-item-ns">{g.namespace}</span>
                              <span className="grants-item-sep">/</span>
                              <code>{g.path === '/' ? '(all)' : g.path}</code>
                            </div>
                            <div className="grants-item-actions">
                              <button
                                className={`share-perm-btn ${g.permission}`}
                                onClick={() => handleToggle(g)}
                                title={`Switch to ${g.permission === 'write' ? 'read' : 'write'}`}
                              >
                                {g.permission === 'write' ? 'Can edit' : 'Can view'}
                              </button>
                              <button className="share-revoke-btn" onClick={() => handleRevoke(g)} title="Remove">x</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <UserAddGrant userId={user.id} namespaces={namespaces} existingGrants={userGrants} onDone={loadAll} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function UserAddGrant({ userId, namespaces, existingGrants, onDone }) {
  const [ns, setNs] = useState('');
  const [path, setPath] = useState('/');
  const [perm, setPerm] = useState('write');
  const [error, setError] = useState('');

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!ns) return;
    setError('');
    try {
      await adminCreateGrant(userId, ns, path || '/', perm);
      setNs('');
      setPath('/');
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="grants-add-form" onSubmit={handleAdd}>
      {error && <div className="share-error" style={{ padding: '4px 0' }}>{error}</div>}
      <div className="grants-add-row">
        <select value={ns} onChange={(e) => setNs(e.target.value)} required>
          <option value="">Namespace...</option>
          {namespaces.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <input type="text" placeholder="/ = all, or /docs" value={path} onChange={(e) => setPath(e.target.value)} />
        <select value={perm} onChange={(e) => setPerm(e.target.value)}>
          <option value="write">Can edit</option>
          <option value="read">Can view</option>
        </select>
        <button type="submit" disabled={!ns}>+ Add</button>
      </div>
    </form>
  );
}

export default AdminPanel;
