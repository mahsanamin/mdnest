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
  adminListNamespaceAdmins,
  adminAddNamespaceAdmin,
  adminRemoveNamespaceAdmin,
} from '../api.js';
import PathPicker from './PathPicker.jsx';

function AdminPanel({ onClose, namespaces, isSuperAdmin, adminNamespaces, userProvider = 'local' }) {
  const [tab, setTab] = useState('users');

  // Manageable namespaces: superadmin can manage all; namespace admins
  // only their own.
  const manageableNs = isSuperAdmin ? namespaces : (namespaces || []).filter((n) => adminNamespaces.includes(n));

  // In federated modes (firebase, sso) the IdP owns identity, so the
  // invite form skips username + password (backfilled / unused).
  const isFederated = userProvider === 'firebase' || userProvider === 'sso';

  return (
    <div className="admin-panel">
      <div className="admin-header">
        <h2>Admin Panel</h2>
        <div className="admin-header-meta">
          {!isSuperAdmin && (
            <span className="admin-scope-badge" title="Your administrative scope">
              Admin of: {adminNamespaces.join(', ') || '(none)'}
            </span>
          )}
          <button className="admin-close" onClick={onClose}>Back to notes</button>
        </div>
      </div>
      <div className="admin-tabs">
        <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
        <button className={tab === 'grants' ? 'active' : ''} onClick={() => setTab('grants')}>Access Grants</button>
        <button className={tab === 'nsadmins' ? 'active' : ''} onClick={() => setTab('nsadmins')}>Namespace Admins</button>
      </div>
      {tab === 'users' && <UsersTab isSuperAdmin={isSuperAdmin} manageableNs={manageableNs} isFederated={isFederated} />}
      {tab === 'grants' && <GrantsTab namespaces={manageableNs} />}
      {tab === 'nsadmins' && <NamespaceAdminsTab manageableNs={manageableNs} />}
    </div>
  );
}

function UsersTab({ isSuperAdmin, manageableNs, isFederated }) {
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

  // Cycles superadmin <-> admin <-> collaborator. Only superadmins can
  // call this — the backend enforces the same.
  const handleCycleRole = async (user) => {
    let next;
    if (user.role === 'collaborator') next = 'admin';
    else if (user.role === 'admin') next = 'superadmin';
    else next = 'collaborator';
    if (!confirm(`Change ${user.username}'s role to ${next}?`)) return;
    try {
      await adminUpdateRole(user.id, next);
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

      {showInvite && (
        <InviteForm
          isSuperAdmin={isSuperAdmin}
          manageableNs={manageableNs}
          isFederated={isFederated}
          onDone={() => { setShowInvite(false); load(); }}
        />
      )}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Role</th>
            <th>Created</th>
            {isSuperAdmin && <th>Actions</th>}
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
              {isSuperAdmin && (
                <td>
                  <button className="admin-action-btn" onClick={() => handleCycleRole(u)} title="Cycle role: collaborator → admin → superadmin → collaborator">
                    Cycle role
                  </button>
                  <button className="admin-action-btn danger" onClick={() => handleDelete(u)} title="Delete user">
                    Delete
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InviteForm({ isSuperAdmin, manageableNs, isFederated, onDone }) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('collaborator');
  // Namespace is mandatory for non-superadmin callers — the backend
  // requires it. For superadmin it's optional (they can grant access
  // separately via the Grants tab).
  const [namespace, setNamespace] = useState(manageableNs?.[0] || '');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // In federated modes (firebase/sso) we send only email — backend
      // derives a placeholder username from the email's local-part and
      // generates a random unused password. The IdP's `name` claim
      // overwrites the username on first sign-in.
      await adminInviteUser(
        email,
        isFederated ? '' : username,
        isFederated ? '' : password,
        role,
        namespace || undefined,
      );
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
      {isFederated && (
        <div className="admin-hint">
          {/* The user asked: "When SSO is enabled why do we need
              password / username?" Answer in-place so it's clear. */}
          Identity comes from your IdP. We only need the user's email — name and
          profile picture are pulled from the OIDC <code>name</code> /{' '}
          <code>picture</code> claims on first sign-in.
        </div>
      )}
      <div className="admin-form-row">
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        {!isFederated && (
          <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        )}
      </div>
      {!isFederated && (
        <div className="admin-form-row">
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
      )}
      <div className="admin-form-row">
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="collaborator">Collaborator</option>
          <option value="admin">Admin (of this namespace)</option>
          {isSuperAdmin && <option value="superadmin">Super-admin (global)</option>}
        </select>
        <select
          value={namespace}
          onChange={(e) => setNamespace(e.target.value)}
          required={!isSuperAdmin}
        >
          <option value="">{isSuperAdmin ? '(no namespace — grant later)' : 'Select namespace'}</option>
          {(manageableNs || []).map((ns) => (
            <option key={ns} value={ns}>{ns}</option>
          ))}
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
        <select value={ns} onChange={(e) => { setNs(e.target.value); setPath('/'); }} required>
          <option value="">Namespace...</option>
          {namespaces.map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
        <PathPicker namespace={ns} value={path} onChange={setPath} />
        <select value={perm} onChange={(e) => setPerm(e.target.value)}>
          <option value="write">Can edit</option>
          <option value="read">Can view</option>
        </select>
        <button type="submit" disabled={!ns}>+ Add</button>
      </div>
    </form>
  );
}

// NamespaceAdminsTab — promote / demote users as namespace admins of a
// chosen namespace. Visible to anyone who can see the panel; the backend
// scopes both the read (list) and the write (add/remove) operations.
function NamespaceAdminsTab({ manageableNs }) {
  const [selectedNs, setSelectedNs] = useState(manageableNs?.[0] || '');
  const [admins, setAdmins] = useState([]);
  const [users, setUsers] = useState([]);
  const [pickUserId, setPickUserId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!selectedNs) return;
    setLoading(true);
    setError('');
    try {
      const [a, u] = await Promise.all([
        adminListNamespaceAdmins(selectedNs),
        adminListUsers(),
      ]);
      setAdmins(a);
      setUsers(u);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedNs]);

  useEffect(() => { load(); }, [load]);

  const handlePromote = async () => {
    if (!pickUserId) return;
    setError('');
    try {
      await adminAddNamespaceAdmin(parseInt(pickUserId, 10), selectedNs);
      setPickUserId('');
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDemote = async (userId) => {
    if (!confirm(`Remove this user as admin of "${selectedNs}"? Their existing access grant is left in place.`)) return;
    try {
      await adminRemoveNamespaceAdmin(userId, selectedNs);
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  if (!manageableNs || manageableNs.length === 0) {
    return <div className="admin-section">No namespaces available to administer.</div>;
  }

  // Candidates for promotion: users not already admin of this ns,
  // excluding superadmins (who already have global access).
  const adminUserIds = new Set(admins.map((a) => a.user_id));
  const candidates = users.filter((u) => u.role !== 'superadmin' && !adminUserIds.has(u.id));

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>Namespace Admins</h3>
        <select value={selectedNs} onChange={(e) => setSelectedNs(e.target.value)}>
          {manageableNs.map((ns) => <option key={ns} value={ns}>{ns}</option>)}
        </select>
      </div>

      {error && <div className="admin-error">{error}</div>}
      {loading && <div className="admin-hint">Loading…</div>}

      <table className="admin-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Email</th>
            <th>Granted</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {admins.length === 0 ? (
            <tr><td colSpan="4" className="admin-hint">No namespace admins yet.</td></tr>
          ) : admins.map((a) => (
            <tr key={a.user_id}>
              <td>{a.username || '(no username)'}</td>
              <td>{a.email}</td>
              <td>{new Date(a.created_at).toLocaleDateString()}</td>
              <td>
                <button className="admin-action-btn danger" onClick={() => handleDemote(a.user_id)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="admin-form-row" style={{ marginTop: 16 }}>
        <select value={pickUserId} onChange={(e) => setPickUserId(e.target.value)}>
          <option value="">Pick a user to promote…</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>{u.username || u.email} ({u.role})</option>
          ))}
        </select>
        <button onClick={handlePromote} disabled={!pickUserId}>+ Make admin of {selectedNs}</button>
      </div>
    </div>
  );
}

export default AdminPanel;
