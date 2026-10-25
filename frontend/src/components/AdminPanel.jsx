import { useState, useEffect, useCallback, useRef } from 'react';
import {
  adminListUsers,
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
  adminListTokens,
  adminRevokeToken,
} from '../api.js';
import { clearMarpThemeCache } from '../marpThemes.js';
import PathPicker from './PathPicker.jsx';
import { PeopleTab, NamespacesTab, useDirectory } from './AdminPeople.jsx';
import { useGit } from './AdminGit.jsx';

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
  const loadNamespaces = useCallback(async () => {
    try { setManageableNs((await getManageableNamespaces()) || []); }
    catch { /* keep the seeded list on failure */ }
  }, []);
  useEffect(() => { loadNamespaces(); }, [loadNamespaces]);
  // Git backup and adding namespaces live in the Namespaces tab (superadmin).
  const git = useGit(isSuperAdmin);

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
        {isSuperAdmin && marpThemesEnabled && (
          <button className={tab === 'marp-themes' ? 'active' : ''} onClick={() => setTab('marp-themes')}>Marp Themes</button>
        )}
        {isSuperAdmin && (
          <button className={tab === 'api-tokens' ? 'active' : ''} onClick={() => setTab('api-tokens')}>API Tokens</button>
        )}
      </div>
      {tab === 'people' && <PeopleTab isSuperAdmin={isSuperAdmin} namespaces={manageableNs} isFederated={isFederated} userProvider={userProvider} grantMaxDepth={grantMaxDepth} directory={directory} git={git} />}
      {tab === 'groups' && isSuperAdmin && <GroupsTab namespaces={manageableNs} grantMaxDepth={grantMaxDepth} />}
      {tab === 'namespaces' && <NamespacesTab isSuperAdmin={isSuperAdmin} namespaces={manageableNs} grantMaxDepth={grantMaxDepth} directory={directory} git={git} onNamespacesChanged={loadNamespaces} />}
      {tab === 'marp-themes' && isSuperAdmin && marpThemesEnabled && <MarpThemesTab />}
      {tab === 'api-tokens' && isSuperAdmin && <ApiTokensTab />}
    </div>
  );
}

// ApiTokensTab: every person's API tokens, with the owner, for a superadmin to
// audit and revoke. Settings > API Tokens only ever shows your own.
function ApiTokensTab() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setTokens((await adminListTokens()) || []);
      setError('');
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  const handleRevoke = async (t) => {
    const owner = t.username || 'no owner';
    if (!window.confirm(`Revoke ${owner}'s token "${t.name}"? Their CLI, MCP and API clients using it stop working.`)) return;
    try {
      await adminRevokeToken(t.id);
      await load();
    } catch (e) { setError(e.message); }
  };

  if (loading) return <div className="admin-section">Loading...</div>;

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>API Tokens</h3>
      </div>
      <p className="admin-hint">
        Every person&apos;s API tokens. Revoking one stops every CLI, MCP or API client that uses it.
        Your own tokens are managed in Settings.
      </p>
      {error && <div className="share-error">{error}</div>}
      {tokens.length === 0 ? (
        <div className="admin-hint">No API tokens.</div>
      ) : (
        <div className="token-list">
          {tokens.map((t) => (
            <div key={t.id} className="token-item">
              <div className="token-info">
                <span className="token-name">{t.name}</span>
                <span className="token-owner">{t.username || 'no owner'}</span>
                <span className="token-hint">mdnest_•••••{t.token_suffix || '????'}</span>
                <span className="token-date">Created {new Date(t.created_at).toLocaleDateString()}</span>
              </div>
              <button className="token-revoke" onClick={() => handleRevoke(t)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// MarpThemesTab: superadmin editor for the centralized Marp theme catalog.
function MarpThemesTab() {
  const [themes, setThemes] = useState([]);
  const [selected, setSelected] = useState(null); // theme name, or '__new__'
  const [name, setName] = useState('');
  const [css, setCss] = useState('');
  const [templates, setTemplates] = useState('');
  const [part, setPart] = useState('css'); // 'css' | 'templates'
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

  const openTheme = (t) => { setSelected(t.name); setName(t.name); setCss(t.css); setTemplates(t.templates || ''); setPart('css'); setErr(''); setStatus(''); };
  const openNew = () => {
    setSelected('__new__'); setName('');
    setCss("/* @theme my-theme */\n@import 'default';\n\nsection {\n}\n");
    setTemplates(''); setPart('css');
    setErr(''); setStatus('');
  };

  const save = async () => {
    setErr(''); setStatus(''); setBusy(true);
    try {
      await saveMarpTheme(name.trim(), css, templates);
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
      if (selected === t) { setSelected(null); setName(''); setCss(''); setTemplates(''); }
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
            <div className="marp-theme-parts" role="tablist">
              <button type="button" role="tab" aria-selected={part === 'css'} className={part === 'css' ? 'active' : ''} onClick={() => setPart('css')}>CSS</button>
              <button type="button" role="tab" aria-selected={part === 'templates'} className={part === 'templates' ? 'active' : ''} onClick={() => setPart('templates')}>Slide templates</button>
            </div>
            {part === 'css' ? (
              <textarea
                className="marp-theme-css"
                value={css}
                onChange={(e) => setCss(e.target.value)}
                spellCheck={false}
                rows={22}
                aria-label="Theme CSS"
              />
            ) : (
              <>
                <p className="admin-hint">
                  Optional. A Marp deck that uses this theme, one slide per kind of slide. <strong>+ Slides</strong> offers
                  each slide as a template and builds a new deck from the ones picked; its front matter
                  (<code>html</code>, <code>class</code>, <code>footer</code>…) is the starting point. Name a template
                  with <code>&lt;!-- template: Cards --&gt;</code> in its slide, or it is named after its first heading.
                </p>
                <textarea
                  className="marp-theme-css"
                  value={templates}
                  onChange={(e) => setTemplates(e.target.value)}
                  spellCheck={false}
                  rows={20}
                  aria-label="Slide templates"
                  data-testid="marp-theme-templates"
                />
              </>
            )}
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
