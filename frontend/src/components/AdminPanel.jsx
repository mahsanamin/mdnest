import { useState, useEffect, useCallback, useRef } from 'react';
import {
  adminListUsers,
  adminListWorkspaces,
  adminSaveWorkspace,
  adminDeleteWorkspace,
  adminListWorkspaceGroups,
  adminSaveWorkspaceGroup,
  adminDeleteWorkspaceGroup,
  adminCreateWorkspaceInGroup,
  getManageableNamespaces,
  getMarpThemes,
  saveMarpTheme,
  deleteMarpTheme,
  adminListGroups,
  adminCreateGroup,
  adminUpdateGroup,
  adminDeleteGroup,
  adminListGroupMembers,
  adminAddGroupUser,
  adminAddGroupOIDC,
  adminRemoveGroupUser,
  adminRemoveGroupOIDC,
  adminListGroupGrants,
  adminCreateGroupGrant,
  adminUpdateGroupGrant,
  adminDeleteGroupGrant,
} from '../api.js';
import { clearMarpThemeCache } from './MarpDeck.jsx';
import PathPicker from './PathPicker.jsx';
import { PeopleTab, NamespacesTab, useDirectory } from './AdminPeople.jsx';

function AdminPanel({ onClose, namespaces, isSuperAdmin, adminNamespaces, userProvider = 'local', grantMaxDepth = 0, marpThemesEnabled = false }) {
  const [tab, setTab] = useState('people');

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

  // People, Groups and Namespaces all read one directory, loaded once here,
  // so a change made in one tab is already there when you switch.
  const directory = useDirectory({ isSuperAdmin, namespaces: manageableNs });
  // Groups edits its members and grants on its own; re-read on the way back.
  const { reload } = directory;
  const firstTab = useRef(true);
  useEffect(() => {
    if (firstTab.current) { firstTab.current = false; return; }
    if (tab === 'people' || tab === 'namespaces') reload();
  }, [tab, reload]);

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
        <button className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>People</button>
        {isSuperAdmin && (
          <button className={tab === 'groups' ? 'active' : ''} onClick={() => setTab('groups')}>Groups</button>
        )}
        <button className={tab === 'namespaces' ? 'active' : ''} onClick={() => setTab('namespaces')}>Namespaces</button>
        {isSuperAdmin && (
          <button className={tab === 'workspaces' ? 'active' : ''} onClick={() => setTab('workspaces')}>Git Workspaces</button>
        )}
        {isSuperAdmin && marpThemesEnabled && (
          <button className={tab === 'marp-themes' ? 'active' : ''} onClick={() => setTab('marp-themes')}>Marp Themes</button>
        )}
      </div>
      {tab === 'people' && <PeopleTab isSuperAdmin={isSuperAdmin} namespaces={manageableNs} isFederated={isFederated} userProvider={userProvider} grantMaxDepth={grantMaxDepth} directory={directory} />}
      {tab === 'groups' && isSuperAdmin && <GroupsTab namespaces={manageableNs} grantMaxDepth={grantMaxDepth} />}
      {tab === 'namespaces' && <NamespacesTab isSuperAdmin={isSuperAdmin} namespaces={manageableNs} grantMaxDepth={grantMaxDepth} directory={directory} />}
      {tab === 'workspaces' && isSuperAdmin && <WorkspacesTab />}
      {tab === 'marp-themes' && isSuperAdmin && marpThemesEnabled && <MarpThemesTab />}
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
    if (!confirm(deleteConfirmText(w, 'Delete'))) return;
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
      {err && <div style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>{err}</div>}

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
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading...</p>
        ) : list.filter((w) => !w.group_id).length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No standalone workspaces configured.</p>
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

// hasDurableCopy reports whether a workspace's notes survive being removed from
// local storage — true only when it mirrors and its last sync succeeded, so the
// remote holds the current notes (a timestamp alone is stamped on failed syncs
// too, so it is not enough).
function hasDurableCopy(w) {
  return !!(w.git_enabled && w.last_sync_at && !w.last_sync_error);
}

// deleteConfirmText words the delete/remove confirmation honestly: only promise
// that notes are kept when a synced mirror actually exists.
function deleteConfirmText(w, verb) {
  const base = `${verb} "${w.namespace}"? This revokes all access grants + namespace admins.`;
  return hasDurableCopy(w)
    ? `${base} The namespace is removed from mdnest — your notes are kept in the git mirror repository.`
    : `${base} The notes are NOT deleted: there is no synced mirror to restore from, so the namespace and its contents stay. Remove them separately if you want them gone.`;
}

// syncBadge renders a workspace's honest mirror-sync state. "ok" (green) is
// shown only after a confirmed successful sync (last_sync_at set with no error);
// a git-enabled workspace that has never synced — or whose remote repo is not
// created yet (a "pending:" status) — is "pending", not "ok" and not a red error.
function syncBadge(w) {
  if (!w.git_enabled) return <span style={{ color: 'var(--text-muted)' }}>off</span>;
  const err = w.last_sync_error;
  if (err && err.startsWith('pending:')) return <span style={{ color: 'var(--text-muted)' }} title={err}>pending</span>;
  if (err) return <span style={{ color: 'var(--danger)' }} title={err}>error</span>;
  if (w.last_sync_at) return <span style={{ color: 'var(--success)' }} title={`last synced ${new Date(w.last_sync_at).toLocaleString()}`}>ok</span>;
  return <span style={{ color: 'var(--text-muted)' }} title="No successful sync yet">pending</span>;
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
    if (!confirm(`Delete group "${g.name}" and its ${g.workspace_count} project(s)? This revokes all access grants + namespace admins for each. Projects with a synced git mirror are removed from mdnest (notes kept in the mirror); the others keep their local notes.`)) return;
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
    if (!confirm(deleteConfirmText(w, 'Remove'))) return;
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
      {err && <div style={{ color: 'var(--danger)', fontSize: '0.85rem', marginBottom: '0.4rem' }}>{err}</div>}

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
        {loading ? <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading...</p>
          : groups.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No groups yet.</p>
          : groups.map((g) => {
            const provisioned = g.source === 'provisioned';
            const members = workspaces.filter((w) => w.group_id === g.id);
            const implicit = g.implicit_namespaces || [];
            const base = (g.base_url || '').replace(/\/$/, '');
            const projectCount = members.length + implicit.length;
            return (
            <div key={g.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '0.5rem 0.6rem', marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <strong>{g.name}</strong>
                {provisioned
                  ? <span className="admin-scope-badge" title="Reconciled from the deployment config (GIT_REMOTE_URL). You can manage its sub-projects, but not edit or delete the group.">provisioned</span>
                  : <span className="role-badge collaborator">ui</span>}
                <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{g.transport} · {g.base_url} · {g.branch} · cred {g.has_credential ? 'yes' : 'no'} · {projectCount} project{projectCount === 1 ? '' : 's'}</span>
                <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {provisioned
                    ? <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }} title="Managed by the deployment (env config)">🔒 managed by deployment</span>
                    : <>
                        <button className="admin-action-btn" onClick={() => edit(g)}>Edit</button>
                        <button className="admin-action-btn danger" onClick={() => del(g)}>Delete</button>
                      </>}
                </span>
              </div>

              <div style={{ marginTop: '0.5rem' }}>
                {members.length === 0 && implicit.length === 0
                  ? <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: '0.2rem 0' }}>No projects in this group yet.</p>
                  : (
                    <table className="admin-table" style={{ fontSize: '0.8rem' }}>
                      <thead>
                        <tr><th>Project (namespace)</th><th>Repository</th><th>On</th><th>Sync</th><th></th></tr>
                      </thead>
                      <tbody>
                        {members.map((w) => (
                          <tr key={w.id}>
                            <td>{w.namespace}</td>
                            <td style={{ color: 'var(--text-secondary)' }} title={`${base}/${w.namespace}.git`}>{w.namespace}.git</td>
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
                            <td style={{ color: 'var(--text-secondary)' }} title={`${base}/${ns}.git`}>{ns}.git</td>
                            <td>yes</td>
                            <td><span style={{ color: 'var(--text-muted)' }}>—</span></td>
                            <td style={{ color: 'var(--text-muted)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>managed by deployment</td>
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

// MarpThemesTab: superadmin editor for the centralized Marp theme catalog.
function MarpThemesTab() {
  const [themes, setThemes] = useState([]);
  const [selected, setSelected] = useState(null); // theme name, or '__new__'
  const [name, setName] = useState('');
  const [css, setCss] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const t = await getMarpThemes();
      setThemes(Array.isArray(t) ? t : []);
    } catch { setThemes([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const openTheme = (t) => { setSelected(t.name); setName(t.name); setCss(t.css); setErr(''); setStatus(''); };
  const openNew = () => {
    setSelected('__new__'); setName('');
    setCss("/* @theme my-theme */\n@import 'default';\n\nsection {\n}\n");
    setErr(''); setStatus('');
  };

  const save = async () => {
    setErr(''); setStatus(''); setBusy(true);
    try {
      await saveMarpTheme(name.trim(), css);
      clearMarpThemeCache();
      setStatus('Saved. Open decks pick it up on reload.');
      setSelected(name.trim());
      await load();
    } catch (e) { setErr(e.message || 'Save failed'); }
    finally { setBusy(false); }
  };

  const remove = async (t) => {
    if (!confirm(`Delete theme "${t}"? Decks using it fall back to the default Marp theme.`)) return;
    setBusy(true); setErr('');
    try {
      await deleteMarpTheme(t);
      clearMarpThemeCache();
      if (selected === t) { setSelected(null); setName(''); setCss(''); }
      await load();
    } catch (e) { setErr(e.message || 'Delete failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="marp-themes-tab">
      <div className="admin-section-header">
        <h3>Marp Themes</h3>
        <button onClick={openNew}>+ New theme</button>
      </div>
      <p className="admin-hint">
        Centralized presentation styles. A deck selects one with <code>theme: &lt;name&gt;</code> in its
        frontmatter instead of embedding a <code>style:</code> block. Start the CSS with
        <code> /* @theme name */ </code> and usually <code>@import 'default';</code>.
      </p>
      <div className="marp-themes-layout">
        <ul className="marp-themes-list">
          {themes.length === 0 && <li className="admin-hint">No themes yet.</li>}
          {themes.map((t) => (
            <li key={t.name} className={selected === t.name ? 'active' : ''}>
              <span className="marp-theme-name" onClick={() => openTheme(t)}>{t.name}</span>
              <button className="danger" onClick={() => remove(t.name)} title="Delete theme">✕</button>
            </li>
          ))}
        </ul>
        {selected && (
          <div className="marp-theme-editor">
            <label className="marp-theme-name-field">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-theme"
                disabled={selected !== '__new__'}
              />
            </label>
            <textarea
              className="marp-theme-css"
              value={css}
              onChange={(e) => setCss(e.target.value)}
              spellCheck={false}
              rows={22}
            />
            {err && <div className="admin-error">{err}</div>}
            {status && <div className="admin-hint">{status}</div>}
            <div className="marp-theme-actions">
              <button className="modal-btn-primary" onClick={save} disabled={busy || !name.trim() || !css.trim()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// GroupsTab — superadmin-only management of role-based access "Groups": named
// sets whose members are mdnest users and/or IdP (OIDC) group IDs, each
// carrying namespace grants. A user's effective access is the union of their
// own grants and the grants of every group they belong to.
function GroupsTab({ namespaces, grantMaxDepth }) {
  const [groups, setGroups] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [g, u] = await Promise.all([adminListGroups(), adminListUsers()]);
      setGroups(g);
      setUsers(u);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setError('');
    try {
      await adminCreateGroup(newName.trim(), newDesc.trim());
      setNewName('');
      setNewDesc('');
      await load();
    } catch (err) { setError(err.message); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this group? Its members and namespace grants are removed. Users keep any direct grants.')) return;
    try {
      await adminDeleteGroup(id);
      if (expanded === id) setExpanded(null);
      await load();
    } catch (err) { setError(err.message); }
  };

  if (loading) return <div className="admin-section">Loading...</div>;

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>Groups</h3>
      </div>
      <p className="admin-hint">
        A group bundles mdnest users and/or IdP (OIDC) group IDs and grants them access to
        namespaces. Effective access is the union of a user&apos;s own grants and the grants of
        every group they belong to. OIDC-group membership is read from the login token, so a
        change there applies on the member&apos;s next sign-in.
      </p>

      {error && <div className="share-error">{error}</div>}

      <form className="grants-add-form" onSubmit={handleCreate}>
        <div className="grants-add-row">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New group name" required />
          <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description (optional)" />
          <button type="submit" disabled={!newName.trim()}>+ Create</button>
        </div>
      </form>

      {groups.length === 0 ? (
        <div className="admin-hint">No groups yet.</div>
      ) : (
        <div className="grants-user-list">
          {groups.map((g) => {
            const isExpanded = expanded === g.id;
            return (
              <div key={g.id} className={`grants-user-card${isExpanded ? ' expanded' : ''}`}>
                <div className="grants-user-header" onClick={() => setExpanded(isExpanded ? null : g.id)}>
                  <div className="grants-user-info">
                    <div className="grants-user-avatar">{g.name.slice(0, 1).toUpperCase()}</div>
                    <div>
                      <div className="grants-user-name">{g.name}</div>
                      {g.description && <div className="grants-user-email">{g.description}</div>}
                    </div>
                  </div>
                  <div className="grants-user-summary">
                    <span className="grants-chevron">{isExpanded ? '\u25B2' : '\u25BC'}</span>
                  </div>
                </div>
                {isExpanded && (
                  <div className="grants-user-body">
                    <GroupMembers groupId={g.id} users={users} />
                    <GroupGrants groupId={g.id} namespaces={namespaces} grantMaxDepth={grantMaxDepth} />
                    <div className="grants-add-row group-delete-row">
                      <button className="share-revoke-btn" onClick={() => handleDelete(g.id)}>Delete group</button>
                    </div>
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

// GroupMembers — user members (via a picker) and OIDC-group members (free-text
// group ID + optional human label for the superadmin's own reference).
function GroupMembers({ groupId, users }) {
  const [members, setMembers] = useState([]);
  const [pickUserId, setPickUserId] = useState('');
  const [oidcId, setOidcId] = useState('');
  const [oidcLabel, setOidcLabel] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setMembers(await adminListGroupMembers(groupId)); } catch (e) { setError(e.message); }
  }, [groupId]);
  useEffect(() => { load(); }, [load]);

  const memberUserIds = new Set(members.filter((m) => m.user_id != null).map((m) => m.user_id));
  const candidates = users.filter((u) => !memberUserIds.has(u.id));

  const addUser = async () => {
    if (!pickUserId) return;
    setError('');
    try { await adminAddGroupUser(groupId, Number(pickUserId)); setPickUserId(''); await load(); }
    catch (err) { setError(err.message); }
  };
  const addOIDC = async (e) => {
    e.preventDefault();
    if (!oidcId.trim()) return;
    setError('');
    try { await adminAddGroupOIDC(groupId, oidcId.trim(), oidcLabel.trim()); setOidcId(''); setOidcLabel(''); await load(); }
    catch (err) { setError(err.message); }
  };
  const removeUser = async (uid) => { try { await adminRemoveGroupUser(groupId, uid); await load(); } catch (err) { setError(err.message); } };
  const removeOIDC = async (gid) => { try { await adminRemoveGroupOIDC(groupId, gid); await load(); } catch (err) { setError(err.message); } };

  const userMembers = members.filter((m) => m.user_id != null);
  const oidcMembers = members.filter((m) => m.oidc_group != null);

  return (
    <div className="group-members">
      {error && <div className="share-error">{error}</div>}
      <h4>Members</h4>
      <div className="grants-list">
        {userMembers.map((m) => (
          <div key={`u${m.user_id}`} className="grants-item">
            <div className="grants-item-path"><span className="grants-item-ns">{m.username || `user #${m.user_id}`}</span></div>
            <div className="grants-item-actions">
              <button className="share-revoke-btn" onClick={() => removeUser(m.user_id)} title="Remove">x</button>
            </div>
          </div>
        ))}
        {oidcMembers.map((m) => (
          <div key={`o${m.oidc_group}`} className="grants-item">
            <div className="grants-item-path">
              <span className="grants-item-ns">{m.oidc_label || 'OIDC group'}</span>
              <span className="grants-item-sep">/</span>
              <code>{m.oidc_group}</code>
            </div>
            <div className="grants-item-actions">
              <button className="share-revoke-btn" onClick={() => removeOIDC(m.oidc_group)} title="Remove">x</button>
            </div>
          </div>
        ))}
        {members.length === 0 && <div className="admin-hint">No members yet.</div>}
      </div>

      <div className="grants-add-row">
        <select value={pickUserId} onChange={(e) => setPickUserId(e.target.value)}>
          <option value="">Add a user...</option>
          {candidates.map((u) => (<option key={u.id} value={u.id}>{u.username} ({u.email})</option>))}
        </select>
        <button type="button" disabled={!pickUserId} onClick={addUser}>+ Add user</button>
      </div>

      <form className="grants-add-row" onSubmit={addOIDC}>
        <input value={oidcId} onChange={(e) => setOidcId(e.target.value)} placeholder="OIDC group ID (e.g. Entra object ID)" />
        <input value={oidcLabel} onChange={(e) => setOidcLabel(e.target.value)} placeholder="Display name (for reference only)" />
        <button type="submit" disabled={!oidcId.trim()}>+ Add OIDC group</button>
      </form>
    </div>
  );
}

// GroupGrants — the namespace grants attached to a group (mirrors the per-user
// Access Grants UI).
function GroupGrants({ groupId, namespaces, grantMaxDepth }) {
  const [grants, setGrants] = useState([]);
  const [ns, setNs] = useState('');
  const [path, setPath] = useState('/');
  const [perm, setPerm] = useState('write');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setGrants(await adminListGroupGrants(groupId)); } catch (e) { setError(e.message); }
  }, [groupId]);
  useEffect(() => { load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    if (!ns) return;
    setError('');
    try { await adminCreateGroupGrant(groupId, ns, path || '/', perm); setNs(''); setPath('/'); await load(); }
    catch (err) { setError(err.message); }
  };
  const toggle = async (g) => {
    try { await adminUpdateGroupGrant(g.id, g.permission === 'write' ? 'read' : 'write'); await load(); }
    catch (err) { setError(err.message); }
  };
  const revoke = async (g) => { try { await adminDeleteGroupGrant(g.id); await load(); } catch (err) { setError(err.message); } };

  return (
    <div className="group-grants">
      {error && <div className="share-error">{error}</div>}
      <h4>Namespace access</h4>
      <div className="grants-list">
        {grants.map((g) => (
          <div key={g.id} className="grants-item">
            <div className="grants-item-path">
              <span className="grants-item-ns">{g.namespace}</span>
              <span className="grants-item-sep">/</span>
              <code>{g.path === '/' ? '(all)' : g.path}</code>
            </div>
            <div className="grants-item-actions">
              <button className={`share-perm-btn ${g.permission}`} onClick={() => toggle(g)} title={`Switch to ${g.permission === 'write' ? 'read' : 'write'}`}>
                {g.permission === 'write' ? 'Can edit' : 'Can view'}
              </button>
              <button className="share-revoke-btn" onClick={() => revoke(g)} title="Remove">x</button>
            </div>
          </div>
        ))}
        {grants.length === 0 && <div className="admin-hint">No namespace access yet.</div>}
      </div>
      <form className="grants-add-row" onSubmit={add}>
        <select value={ns} onChange={(e) => { setNs(e.target.value); setPath('/'); }} required>
          <option value="">Namespace...</option>
          {namespaces.map((n) => (<option key={n} value={n}>{n}</option>))}
        </select>
        <PathPicker namespace={ns} value={path} onChange={setPath} maxDepth={grantMaxDepth} />
        <select value={perm} onChange={(e) => setPerm(e.target.value)}>
          <option value="write">Can edit</option>
          <option value="read">Can view</option>
        </select>
        <button type="submit" disabled={!ns}>+ Add</button>
      </form>
    </div>
  );
}

export default AdminPanel;
