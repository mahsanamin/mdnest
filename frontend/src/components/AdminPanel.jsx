import { useState, useEffect, useCallback } from 'react';
import {
  adminListUsers,
  adminInviteUser,
  adminDeleteUser,
  adminUpdateRole,
  adminListGrants,
  adminCreateGrant,
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
  const [selectedUser, setSelectedUser] = useState(null);
  const [grants, setGrants] = useState([]);
  const [loading, setLoading] = useState(false);

  // Form state
  const [grantNs, setGrantNs] = useState('');
  const [grantPath, setGrantPath] = useState('/');
  const [grantPerm, setGrantPerm] = useState('write');

  useEffect(() => {
    adminListUsers().then(setUsers).catch(console.error);
  }, []);

  useEffect(() => {
    if (!selectedUser) { setGrants([]); return; }
    setLoading(true);
    adminListGrants({ user_id: selectedUser }).then(setGrants).catch(console.error).finally(() => setLoading(false));
  }, [selectedUser]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!selectedUser || !grantNs) return;
    try {
      await adminCreateGrant(selectedUser, grantNs, grantPath || '/', grantPerm);
      const updated = await adminListGrants({ user_id: selectedUser });
      setGrants(updated);
      setGrantPath('/');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async (grantId) => {
    try {
      await adminDeleteGrant(grantId);
      const updated = await adminListGrants({ user_id: selectedUser });
      setGrants(updated);
    } catch (err) {
      alert(err.message);
    }
  };

  // Only show non-admin users (admins have full access)
  const collaborators = users.filter((u) => u.role === 'collaborator');

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>Access Grants</h3>
      </div>

      <div className="admin-grant-selector">
        <label>User: </label>
        <select value={selectedUser || ''} onChange={(e) => setSelectedUser(e.target.value ? parseInt(e.target.value) : null)}>
          <option value="">Select a user...</option>
          {collaborators.map((u) => (
            <option key={u.id} value={u.id}>{u.username} ({u.email})</option>
          ))}
        </select>
        {collaborators.length === 0 && <span className="admin-hint">No collaborators yet. Invite a user first.</span>}
      </div>

      {selectedUser && (
        <>
          <form className="admin-grant-form" onSubmit={handleCreate}>
            <select value={grantNs} onChange={(e) => setGrantNs(e.target.value)} required>
              <option value="">Namespace...</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Path (/ = full namespace)"
              value={grantPath}
              onChange={(e) => setGrantPath(e.target.value)}
            />
            <select value={grantPerm} onChange={(e) => setGrantPerm(e.target.value)}>
              <option value="write">Write</option>
              <option value="read">Read</option>
            </select>
            <button type="submit">Add Grant</button>
          </form>

          {loading && <div>Loading...</div>}

          {grants.length > 0 ? (
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Namespace</th>
                  <th>Path</th>
                  <th>Permission</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {grants.map((g) => (
                  <tr key={g.id}>
                    <td>{g.namespace}</td>
                    <td><code>{g.path}</code></td>
                    <td><span className={`perm-badge ${g.permission}`}>{g.permission}</span></td>
                    <td>
                      <button className="admin-action-btn danger" onClick={() => handleDelete(g.id)}>Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            !loading && <div className="admin-hint">No grants for this user. Add one above.</div>
          )}
        </>
      )}
    </div>
  );
}

export default AdminPanel;
