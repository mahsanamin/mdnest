import { useState, useEffect, useCallback, useRef } from 'react';
import {
  adminListUsers,
  adminInviteUser,
  adminDeleteUser,
  adminUpdateRole,
  adminResetPassword,
  adminListGrants,
  adminCreateGrant,
  adminUpdateGrant,
  adminDeleteGrant,
  adminListNamespaceAdmins,
  adminAddNamespaceAdmin,
  adminRemoveNamespaceAdmin,
  adminListWorkspaces,
  adminSaveWorkspace,
  adminDeleteWorkspace,
  adminListWorkspaceGroups,
  adminSaveWorkspaceGroup,
  adminDeleteWorkspaceGroup,
  adminCreateWorkspaceInGroup,
  getManageableNamespaces,
} from '../api.js';
import PathPicker from './PathPicker.jsx';

function AdminPanel({ onClose, namespaces, isSuperAdmin, adminNamespaces, userProvider = 'local', grantMaxDepth = 0 }) {
  const [tab, setTab] = useState('users');

  // Management-plane namespace list. A superadmin no longer has implicit data
  // access to namespaces, so the `namespaces` prop (which mirrors the sidebar /
  // data-access list) can't drive namespace management. Fetch the administrable
  // set from the management endpoint instead; it is already scoped per role
  // (all for superadmin, own namespaces for a namespace admin). The prop seeds
  // the initial render to avoid a flash before the fetch resolves.
  const [manageableNs, setManageableNs] = useState(() =>
    isSuperAdmin ? (namespaces || []) : (namespaces || []).filter((n) => adminNamespaces.includes(n)),
  );
  useEffect(() => {
    let cancelled = false;
    getManageableNamespaces()
      .then((ns) => { if (!cancelled) setManageableNs(ns || []); })
      .catch(() => { /* keep the seeded list on failure */ });
    return () => { cancelled = true; };
  }, []);

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
        {isSuperAdmin && (
          <button className={tab === 'workspaces' ? 'active' : ''} onClick={() => setTab('workspaces')}>Git Workspaces</button>
        )}
      </div>
      {tab === 'users' && <UsersTab isSuperAdmin={isSuperAdmin} manageableNs={manageableNs} isFederated={isFederated} userProvider={userProvider} />}
      {tab === 'grants' && <GrantsTab namespaces={manageableNs} grantMaxDepth={grantMaxDepth} />}
      {tab === 'nsadmins' && <NamespaceAdminsTab manageableNs={manageableNs} />}
      {tab === 'workspaces' && isSuperAdmin && <WorkspacesTab />}
    </div>
  );
}

function UsersTab({ isSuperAdmin, manageableNs, isFederated, userProvider }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInvite, setShowInvite] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);

  // Password reset is only meaningful for the local identity provider —
  // Firebase / SSO accounts authenticate against the IdP and have no
  // local password. Superadmins reset other superadmins through the
  // host-side mdnest-server CLI, not the UI.
  const canShowReset = isSuperAdmin && userProvider === 'local';

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

  // Pick a role directly. Backend rejects "cannot remove the last
  // superadmin" and other invalid transitions, so we surface the error
  // and reload to revert the optimistic select state.
  const handleRoleChange = async (user, newRole) => {
    if (newRole === user.role) return;
    if (!confirm(`Change ${user.username || user.email}'s role from ${user.role} to ${newRole}?`)) {
      load();
      return;
    }
    try {
      await adminUpdateRole(user.id, newRole);
      load();
    } catch (e) {
      alert(e.message);
      load();
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

      {resetTarget && (
        <ResetPasswordModal
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={() => { setResetTarget(null); load(); }}
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
                {isSuperAdmin ? (
                  <select
                    className={`admin-role-select role-${u.role}`}
                    value={u.role}
                    onChange={(e) => handleRoleChange(u, e.target.value)}
                    title="Change role. Note: setting Admin here only flips the global flag — namespace scope is assigned in the Namespace Admins tab."
                  >
                    <option value="collaborator">Collaborator</option>
                    <option value="admin">Admin</option>
                    <option value="superadmin">Super-admin</option>
                  </select>
                ) : (
                  <span className={`role-badge ${u.role}`}>{u.role}</span>
                )}
              </td>
              <td>{new Date(u.created_at).toLocaleDateString()}</td>
              {isSuperAdmin && (
                <td>
                  {canShowReset && u.role !== 'superadmin' && (
                    <button
                      className="admin-action-btn"
                      onClick={() => setResetTarget(u)}
                      title="Set a new password — user is forced to change it on next login"
                      style={{ marginRight: 6 }}
                    >
                      Reset password
                    </button>
                  )}
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

function ResetPasswordModal({ user, onClose, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (pw.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (pw !== pw2) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await adminResetPassword(user.id, pw);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Reset password — {user.username || user.email}</h3>
        <p className="admin-hint" style={{ marginTop: 0 }}>
          They will be forced to choose a new password on their next login.
          Send the temporary password over a secure channel.
        </p>
        <form onSubmit={handleSubmit}>
          {error && <div className="admin-error">{error}</div>}
          <div className="admin-form-row">
            <input
              ref={inputRef}
              type="password"
              placeholder="New temporary password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="admin-form-row">
            <input
              type="password"
              placeholder="Confirm password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          <div className="admin-form-row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={onClose} disabled={loading}>Cancel</button>
            <button type="submit" disabled={loading}>{loading ? 'Resetting…' : 'Reset password'}</button>
          </div>
        </form>
      </div>
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
          <input type="password" name="new-user-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
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

function GrantsTab({ namespaces, grantMaxDepth }) {
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

  // Any user can be granted explicit collaborator-style access to note
  // content, so all roles are listed here. Collaborators and superadmins have
  // no implicit data access at all (since the manage/access split). Admins
  // implicitly reach the namespaces they administer, but still need explicit
  // grants to access *other* namespaces — hence they are grantable too.
  const grantableUsers = users;

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

      {grantableUsers.length === 0 ? (
        <div className="admin-hint">No users to grant yet. Invite a user first from the Users tab.</div>
      ) : (
        <div className="grants-user-list">
          {grantableUsers.map((user) => {
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
                    <UserAddGrant userId={user.id} namespaces={namespaces} grantMaxDepth={grantMaxDepth} existingGrants={userGrants} onDone={loadAll} />
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

function UserAddGrant({ userId, namespaces, grantMaxDepth, existingGrants, onDone }) {
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
        <PathPicker namespace={ns} value={path} onChange={setPath} maxDepth={grantMaxDepth} />
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

// WorkspacesTab: superadmin CRUD over shared/team git-workspace remotes.
// Personal workspaces (is_personal) are shown read-only — they are managed by
// their owner from Settings → Git remote. The stored credential is never
// returned; the token field stays blank on edit (blank = keep the stored one).
function WorkspacesTab() {
  const empty = { namespace: '', git_enabled: true, transport: 'https', remote_url: '', username: 'oauth2', branch: 'main', known_hosts: '', credential: '' };
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState(null);
  const [err, setErr] = useState('');
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await adminListWorkspaces() || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const reset = () => { setForm(empty); setEditId(null); setErr(''); setShowForm(false); };
  const openCreate = () => { setForm(empty); setEditId(null); setErr(''); setShowForm(true); };

  const edit = (w) => {
    setEditId(w.id);
    setErr('');
    setForm({ namespace: w.namespace, git_enabled: w.git_enabled, transport: w.transport, remote_url: w.remote_url, username: w.username, branch: w.branch, known_hosts: w.known_hosts || '', credential: '' });
    setShowForm(true);
  };

  const save = async () => {
    setErr('');
    try {
      const payload = {
        git_enabled: form.git_enabled,
        transport: form.transport,
        remote_url: form.remote_url.trim(),
        username: form.username.trim(),
        branch: form.branch.trim(),
        known_hosts: form.known_hosts,
      };
      if (!editId) payload.namespace = form.namespace.trim();
      if (form.credential) payload.credential = form.credential;
      await adminSaveWorkspace(payload, editId || undefined);
      reset();
      load();
    } catch (e) {
      setErr(e.message);
    }
  };

  const del = async (w) => {
    if (!confirm(`Delete "${w.namespace}"? This removes the namespace and its notes from mdnest and revokes all access grants + namespace admins. The git remote repository (if any) is kept as the archive.`)) return;
    try {
      await adminDeleteWorkspace(w.id);
      if (editId === w.id) reset();
      load();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <div className="admin-tab-content">
      <div className="admin-description">
        <p>
          Per-namespace git remotes — each namespace mirrors to its own
          repository. Credentials are stored encrypted and never shown again.
        </p>
        <ul>
          <li>
            <strong>Group</strong> — declare a shared remote base + token once,
            then add projects (namespaces); each mirrors to <code>&lt;base&gt;/&lt;namespace&gt;.git</code>.
          </li>
          <li>
            <strong>Standalone</strong> — mirror a single namespace to one
            specific repository.
          </li>
          <li>
            <span className="admin-scope-badge">provisioned</span> — a group
            reconciled from the deployment config (<code>GIT_REMOTE_URL</code>):
            you can add or remove its projects, but the group itself can't be
            edited or deleted.
          </li>
        </ul>
        <p className="admin-description-foot">
          Personal workspaces are managed by each user under Settings → Git remote.
        </p>
      </div>
      {err && <div style={{ color: '#f38ba8', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{err}</div>}

      <GroupsSection workspaces={list} onWorkspacesChanged={load} />

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '1.4rem 0 0.2rem' }}>
        <h4 style={{ margin: 0 }}>Standalone workspaces</h4>
        <button className="modal-btn-primary" onClick={openCreate}>+ Add standalone workspace</button>
      </div>

      {showForm && (
        <div className="modal-backdrop" onClick={reset}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>{editId ? `Edit "${form.namespace}"` : 'Add a standalone workspace'}</h3>
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              {!editId && (
                <input className="modal-input" placeholder="namespace (e.g. team-a)" value={form.namespace} onChange={set('namespace')} />
              )}
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <select className="modal-input" value={form.transport} onChange={set('transport')} style={{ maxWidth: 160 }}>
                  <option value="https">HTTPS</option>
                  <option value="ssh">SSH</option>
                </select>
                <input className="modal-input" placeholder={form.transport === 'ssh' ? 'git@host:grp/ns.git' : 'https://host/grp/ns.git'} value={form.remote_url} onChange={set('remote_url')} style={{ flex: 1 }} />
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                {form.transport === 'https' && (
                  <input className="modal-input" placeholder="username (oauth2)" value={form.username} onChange={set('username')} style={{ maxWidth: 200 }} />
                )}
                <input className="modal-input" placeholder="branch (main)" value={form.branch} onChange={set('branch')} style={{ maxWidth: 160 }} />
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem' }}>
                  <input type="checkbox" checked={form.git_enabled} onChange={set('git_enabled')} /> enabled
                </label>
              </div>
              {form.transport === 'ssh' && (
                <textarea className="modal-input" rows={2} placeholder="known_hosts line (host ssh-ed25519 AAAA...)" value={form.known_hosts} onChange={set('known_hosts')} />
              )}
              <input className="modal-input" type="password" placeholder={form.transport === 'ssh' ? 'private key (blank = keep)' : 'PAT / deploy token (blank = keep)'} value={form.credential} onChange={set('credential')} />
              <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.4rem' }}>
                <button className="modal-btn" onClick={reset}>Cancel</button>
                <button className="modal-btn-primary" onClick={save}>{editId ? 'Save' : 'Add'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: '1rem' }}>
        {loading ? (
          <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>Loading...</p>
        ) : list.filter((w) => !w.group_id).length === 0 ? (
          <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>No standalone workspaces configured.</p>
        ) : (
          <table className="admin-table">
            <thead>
              <tr><th>Namespace</th><th>Transport</th><th>Remote</th><th>Branch</th><th>Cred</th><th>On</th><th></th></tr>
            </thead>
            <tbody>
              {list.filter((w) => !w.group_id).map((w) => (
                <tr key={w.id}>
                  <td>{w.namespace}
                    {w.is_personal && <span className="admin-scope-badge" style={{ marginLeft: 6 }}>personal</span>}
                  </td>
                  <td>{w.transport}</td>
                  <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={w.remote_url}>{w.remote_url}</td>
                  <td>{w.branch}</td>
                  <td>{w.has_credential ? 'yes' : '-'}</td>
                  <td>{w.git_enabled ? 'yes' : '-'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {!w.is_personal && <button className="admin-action-btn" onClick={() => edit(w)}>Edit</button>}
                    {!w.is_personal && <button className="admin-action-btn danger" onClick={() => del(w)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// syncBadge renders a workspace's honest mirror-sync state. "ok" (green) is
// shown only after a confirmed successful sync (last_sync_at set with no error);
// a git-enabled workspace that has never synced — or whose remote repo is not
// created yet (a "pending:" status) — is "pending", not "ok" and not a red error.
function syncBadge(w) {
  if (!w.git_enabled) return <span style={{ color: '#6c7086' }}>off</span>;
  const err = w.last_sync_error;
  if (err && err.startsWith('pending:')) return <span style={{ color: '#6c7086' }} title={err}>pending</span>;
  if (err) return <span style={{ color: '#f38ba8' }} title={err}>error</span>;
  if (w.last_sync_at) return <span style={{ color: '#a6e3a1' }} title={`last synced ${new Date(w.last_sync_at).toLocaleString()}`}>ok</span>;
  return <span style={{ color: '#6c7086' }} title="No successful sync yet">pending</span>;
}

// GroupsSection: superadmin CRUD over workspace groups (a shared remote base +
// token) with a per-group "+ New workspace" action that adds a namespace which
// inherits the group's remote (repo = <base>/<namespace>.git).
function GroupsSection({ workspaces = [], onWorkspacesChanged }) {
  const empty = { name: '', transport: 'https', base_url: '', username: 'oauth2', branch: 'main', known_hosts: '', credential: '' };
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState(null);
  const [err, setErr] = useState('');
  const [newNs, setNewNs] = useState({});
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try { setGroups(await adminListWorkspaceGroups() || []); }
    catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const reset = () => { setForm(empty); setEditId(null); setErr(''); setShowForm(false); };
  const openCreate = () => { setForm(empty); setEditId(null); setErr(''); setShowForm(true); };
  const edit = (g) => {
    setEditId(g.id); setErr('');
    setForm({ name: g.name, transport: g.transport, base_url: g.base_url, username: g.username, branch: g.branch, known_hosts: g.known_hosts || '', credential: '' });
    setShowForm(true);
  };

  const save = async () => {
    setErr('');
    try {
      const payload = { name: form.name.trim(), transport: form.transport, base_url: form.base_url.trim(), username: form.username.trim(), branch: form.branch.trim(), known_hosts: form.known_hosts };
      if (form.credential) payload.credential = form.credential;
      await adminSaveWorkspaceGroup(payload, editId || undefined);
      reset(); load();
    } catch (e) { setErr(e.message); }
  };

  const del = async (g) => {
    if (!confirm(`Delete group "${g.name}" and its ${g.workspace_count} project(s)? Each project namespace and its notes are removed from mdnest and all access grants + namespace admins revoked. The git remote repositories (if any) are kept as archives.`)) return;
    try { await adminDeleteWorkspaceGroup(g.id); if (editId === g.id) reset(); load(); onWorkspacesChanged && onWorkspacesChanged(); }
    catch (e) { setErr(e.message); }
  };

  const addWs = async (g) => {
    const ns = (newNs[g.id] || '').trim();
    if (!ns) return;
    setErr('');
    try {
      await adminCreateWorkspaceInGroup(ns, g.id);
      setNewNs((m) => ({ ...m, [g.id]: '' }));
      load(); onWorkspacesChanged && onWorkspacesChanged();
    } catch (e) { setErr(e.message); }
  };

  // Sub-project (member namespace) CRUD. A grouped workspace inherits the
  // group's remote, so the only editable field is the on/off toggle; delete
  // removes the mirror config (notes stay). Available on every group, including
  // provisioned ones.
  const toggleMember = async (w) => {
    setErr('');
    try {
      await adminSaveWorkspace({ git_enabled: !w.git_enabled }, w.id);
      load(); onWorkspacesChanged && onWorkspacesChanged();
    } catch (e) { setErr(e.message); }
  };
  const delMember = async (w) => {
    if (!confirm(`Remove "${w.namespace}" from this group? This removes the namespace and its notes from mdnest and revokes all access grants + namespace admins. The git remote repository (if any) is kept as the archive.`)) return;
    setErr('');
    try {
      await adminDeleteWorkspace(w.id);
      load(); onWorkspacesChanged && onWorkspacesChanged();
    } catch (e) { setErr(e.message); }
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '0.2rem 0' }}>
        <h4 style={{ margin: 0 }}>Groups</h4>
        <button className="modal-btn-primary" onClick={openCreate}>+ Add group</button>
      </div>
      {err && <div style={{ color: '#f38ba8', fontSize: '0.85rem', marginBottom: '0.4rem' }}>{err}</div>}

      {showForm && (
        <div className="modal-backdrop" onClick={reset}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <h3>{editId ? `Edit group "${form.name}"` : 'Add a group'}</h3>
            <div style={{ display: 'grid', gap: '0.4rem' }}>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input className="modal-input" placeholder="group name (e.g. Team workspaces)" value={form.name} onChange={set('name')} style={{ flex: 1 }} />
                <select className="modal-input" value={form.transport} onChange={set('transport')} style={{ maxWidth: 140 }}>
                  <option value="https">HTTPS</option><option value="ssh">SSH</option>
                </select>
              </div>
              <input className="modal-input" placeholder={form.transport === 'ssh' ? 'base: git@host:group' : 'base: https://host/group'} value={form.base_url} onChange={set('base_url')} />
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                {form.transport === 'https' && <input className="modal-input" placeholder="username (oauth2)" value={form.username} onChange={set('username')} style={{ maxWidth: 200 }} />}
                <input className="modal-input" placeholder="branch (main)" value={form.branch} onChange={set('branch')} style={{ maxWidth: 160 }} />
              </div>
              {form.transport === 'ssh' && <textarea className="modal-input" rows={2} placeholder="known_hosts line (host ssh-ed25519 AAAA...)" value={form.known_hosts} onChange={set('known_hosts')} />}
              <input className="modal-input" type="password" placeholder={form.transport === 'ssh' ? 'shared private key (blank = keep)' : 'shared PAT / deploy token (blank = keep)'} value={form.credential} onChange={set('credential')} />
              <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', marginTop: '0.4rem' }}>
                <button className="modal-btn" onClick={reset}>Cancel</button>
                <button className="modal-btn-primary" onClick={save}>{editId ? 'Save' : 'Add group'}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: '0.8rem' }}>
        {loading ? <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>Loading...</p>
          : groups.length === 0 ? <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>No groups yet.</p>
          : groups.map((g) => {
            const provisioned = g.source === 'provisioned';
            const members = workspaces.filter((w) => w.group_id === g.id);
            const implicit = g.implicit_namespaces || [];
            const base = (g.base_url || '').replace(/\/$/, '');
            const projectCount = members.length + implicit.length;
            return (
            <div key={g.id} style={{ border: '1px solid #313244', borderRadius: 6, padding: '0.5rem 0.6rem', marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <strong>{g.name}</strong>
                {provisioned
                  ? <span className="admin-scope-badge" title="Reconciled from the deployment config (GIT_REMOTE_URL). You can manage its sub-projects, but not edit or delete the group.">provisioned</span>
                  : <span className="role-badge collaborator">ui</span>}
                <span style={{ fontSize: '0.8rem', color: '#a6adc8' }}>{g.transport} · {g.base_url} · {g.branch} · cred {g.has_credential ? 'yes' : 'no'} · {projectCount} project{projectCount === 1 ? '' : 's'}</span>
                <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {provisioned
                    ? <span style={{ fontSize: '0.78rem', color: '#6c7086' }} title="Managed by the deployment (env config)">🔒 managed by deployment</span>
                    : <>
                        <button className="admin-action-btn" onClick={() => edit(g)}>Edit</button>
                        <button className="admin-action-btn danger" onClick={() => del(g)}>Delete</button>
                      </>}
                </span>
              </div>

              <div style={{ marginTop: '0.5rem' }}>
                {members.length === 0 && implicit.length === 0
                  ? <p style={{ color: '#6c7086', fontSize: '0.8rem', margin: '0.2rem 0' }}>No projects in this group yet.</p>
                  : (
                    <table className="admin-table" style={{ fontSize: '0.8rem' }}>
                      <thead>
                        <tr><th>Project (namespace)</th><th>Repository</th><th>On</th><th>Sync</th><th></th></tr>
                      </thead>
                      <tbody>
                        {members.map((w) => (
                          <tr key={w.id}>
                            <td>{w.namespace}</td>
                            <td style={{ color: '#a6adc8' }} title={`${base}/${w.namespace}.git`}>{w.namespace}.git</td>
                            <td>{w.git_enabled ? 'yes' : '-'}</td>
                            <td>{syncBadge(w)}</td>
                            <td style={{ whiteSpace: 'nowrap' }}>
                              <button className="admin-action-btn" onClick={() => toggleMember(w)}>{w.git_enabled ? 'Disable' : 'Enable'}</button>
                              <button className="admin-action-btn danger" onClick={() => delMember(w)}>Remove</button>
                            </td>
                          </tr>
                        ))}
                        {implicit.map((ns) => (
                          <tr key={`imp-${ns}`}>
                            <td>{ns} <span className="admin-scope-badge" style={{ marginLeft: 4 }} title="Existing namespace mirroring under this base via the env default — no explicit workspace row">env default</span></td>
                            <td style={{ color: '#a6adc8' }} title={`${base}/${ns}.git`}>{ns}.git</td>
                            <td>yes</td>
                            <td><span style={{ color: '#6c7086' }}>—</span></td>
                            <td style={{ color: '#6c7086', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>managed by deployment</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
              </div>

              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
                <input className="modal-input" placeholder="new project (namespace) in this group" value={newNs[g.id] || ''} onChange={(e) => setNewNs((m) => ({ ...m, [g.id]: e.target.value }))} onKeyDown={(e) => { if (e.key === 'Enter') addWs(g); }} style={{ flex: 1 }} />
                <button className="modal-btn-primary" onClick={() => addWs(g)}>+ Add project</button>
              </div>
            </div>
            );
          })}
      </div>
    </div>
  );
}

export default AdminPanel;
