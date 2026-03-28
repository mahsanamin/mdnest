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
  const [grants, setGrants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('');

  // Form state
  const [grantUser, setGrantUser] = useState('');
  const [grantNs, setGrantNs] = useState('');
  const [grantPath, setGrantPath] = useState('/');
  const [grantPerm, setGrantPerm] = useState('write');

  const loadGrants = useCallback(async () => {
    try {
      const data = await adminListGrants({});
      setGrants(data);
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => {
    Promise.all([
      adminListUsers().then(setUsers),
      loadGrants(),
    ]).finally(() => setLoading(false));
  }, [loadGrants]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!grantUser || !grantNs) return;
    try {
      await adminCreateGrant(parseInt(grantUser), grantNs, grantPath || '/', grantPerm);
      await loadGrants();
      setShowAdd(false);
      setGrantUser('');
      setGrantPath('/');
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async (grantId) => {
    try {
      await adminDeleteGrant(grantId);
      await loadGrants();
    } catch (err) {
      alert(err.message);
    }
  };

  const collaborators = users.filter((u) => u.role === 'collaborator');

  const filtered = filter
    ? grants.filter((g) => (g.username || '').toLowerCase().includes(filter.toLowerCase()) || g.namespace.toLowerCase().includes(filter.toLowerCase()))
    : grants;

  if (loading) return <div className="admin-section">Loading...</div>;

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>Access Grants ({grants.length})</h3>
        <button onClick={() => setShowAdd(!showAdd)}>
          {showAdd ? 'Cancel' : '+ Add Grant'}
        </button>
      </div>

      {showAdd && (
        <form className="admin-invite-form" onSubmit={handleCreate}>
          <div className="admin-form-row">
            <select value={grantUser} onChange={(e) => setGrantUser(e.target.value)} required>
              <option value="">User...</option>
              {collaborators.map((u) => (
                <option key={u.id} value={u.id}>{u.username}</option>
              ))}
            </select>
            <select value={grantNs} onChange={(e) => setGrantNs(e.target.value)} required>
              <option value="">Namespace...</option>
              {namespaces.map((ns) => (
                <option key={ns} value={ns}>{ns}</option>
              ))}
            </select>
          </div>
          <div className="admin-form-row">
            <input
              type="text"
              placeholder="Path (/ = full namespace)"
              value={grantPath}
              onChange={(e) => setGrantPath(e.target.value)}
            />
            <select value={grantPerm} onChange={(e) => setGrantPerm(e.target.value)}>
              <option value="write">Write</option>
              <option value="read">Read only</option>
            </select>
          </div>
          <button type="submit">Add Grant</button>
          {collaborators.length === 0 && <div className="admin-hint">No collaborators yet. Invite a user first.</div>}
        </form>
      )}

      {grants.length > 0 && (
        <input
          type="text"
          className="admin-filter"
          placeholder="Filter by user or namespace..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      {filtered.length > 0 ? (
        <table className="admin-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Namespace</th>
              <th>Path</th>
              <th>Permission</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((g) => (
              <tr key={g.id}>
                <td><span className="grant-user">{g.username || `#${g.user_id}`}</span></td>
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
        !loading && grants.length === 0 && <div className="admin-hint">No access grants yet. Add one to give collaborators access to namespaces.</div>
      )}
    </div>
  );
}

export default AdminPanel;
