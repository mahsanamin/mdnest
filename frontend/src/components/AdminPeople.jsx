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
  adminListGroups,
  adminListGroupMembers,
  adminAddGroupUser,
  adminRemoveGroupUser,
  adminListGroupGrants,
  adminCreateGroupGrant,
  adminUpdateGroupGrant,
  adminDeleteGroupGrant,
} from '../api.js';
import PathPicker from './PathPicker.jsx';
import { buildDirectory, name, pathLabel, viaLabel, accessSummary, matchesPerson } from '../adminDirectory.js';

// People and Namespaces: the two ways an admin looks at access. Both read the
// same directory (users, their grants, groups, namespace admins), so a change
// made in one shows in the other without a second source of truth.

export function useDirectory({ isSuperAdmin, namespaces }) {
  const [dir, setDir] = useState(null);
  const [error, setError] = useState('');
  const nsKey = (namespaces || []).join('\n');
  const load = useCallback(async () => {
    try {
      const nsList = nsKey ? nsKey.split('\n') : [];
      const [users, grants, groups] = await Promise.all([
        adminListUsers(),
        adminListGrants({}),
        // Groups are superadmin-only on the server.
        isSuperAdmin ? adminListGroups() : Promise.resolve([]),
      ]);
      const gs = groups || [];
      const [members, ggrants, admins] = await Promise.all([
        Promise.all(gs.map((g) => adminListGroupMembers(g.id))),
        Promise.all(gs.map((g) => adminListGroupGrants(g.id))),
        Promise.all(nsList.map((ns) => adminListNamespaceAdmins(ns).catch(() => []))),
      ]);
      const groupMembers = {};
      const groupGrants = {};
      gs.forEach((g, i) => { groupMembers[g.id] = members[i] || []; groupGrants[g.id] = ggrants[i] || []; });
      const nsAdmins = {};
      nsList.forEach((ns, i) => { nsAdmins[ns] = admins[i] || []; });
      setDir({ ...buildDirectory({ users: users || [], grants: grants || [], groups: gs, groupMembers, groupGrants, nsAdmins }), groups: gs });
      setError('');
    } catch (e) {
      setError(e.message || 'Could not load users');
    }
  }, [isSuperAdmin, nsKey]);
  useEffect(() => { load(); }, [load]);
  return { dir, error, reload: load };
}

// Run an admin action, then reload; show what went wrong instead of alert().
function useAction(reload) {
  const [error, setError] = useState('');
  const run = useCallback(async (fn) => {
    setError('');
    try { await fn(); } catch (e) { setError(e.message || 'That did not work'); }
    await reload();
  }, [reload]);
  return { error, setError, run };
}

function PermToggle({ permission, onToggle, disabled }) {
  return (
    <button
      className={`share-perm-btn ${permission}`}
      onClick={onToggle}
      disabled={disabled}
      title={disabled ? undefined : `Switch to ${permission === 'write' ? 'view only' : 'can edit'}`}
    >
      {permission === 'write' ? 'Can edit' : 'Can view'}
    </button>
  );
}

function Chip({ children, onRemove, removeLabel, tone }) {
  return (
    <span className={`adm-chip${tone ? ` ${tone}` : ''}`}>
      {children}
      {onRemove && <button className="adm-chip-x" onClick={onRemove} aria-label={removeLabel} title={removeLabel}>×</button>}
    </span>
  );
}

// A select that acts the moment you pick something, then resets.
function PickToAdd({ placeholder, options, onPick, testId }) {
  if (!options.length) return null;
  return (
    <select className="adm-pick" value="" data-testid={testId} onChange={(e) => { if (e.target.value) onPick(e.target.value); }}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- People

export function PeopleTab({ isSuperAdmin, namespaces, isFederated, userProvider, grantMaxDepth, directory }) {
  const { dir, error: loadError, reload } = directory;
  const { error, setError, run } = useAction(reload);
  const [open, setOpen] = useState(null);
  const [query, setQuery] = useState('');
  const [inviting, setInviting] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);

  if (!dir) return <div className="admin-section">{loadError || 'Loading…'}</div>;
  const people = dir.people.filter((p) => matchesPerson(p, query));

  return (
    <div className="admin-section">
      <div className="admin-section-header">
        <h3>People ({dir.people.length})</h3>
        <div className="adm-header-actions">
          {dir.people.length > 6 && (
            <input className="adm-search" placeholder="Find a person or group" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a person" />
          )}
          <button onClick={() => setInviting((v) => !v)} data-testid="adm-invite-toggle">{inviting ? 'Cancel' : '+ Add person'}</button>
        </div>
      </div>
      <p className="admin-hint adm-intro">
        Click a person to see everything they can reach and change it in one place. Give access
        through a group when several people need the same thing.
      </p>

      {inviting && (
        <InviteForm
          isSuperAdmin={isSuperAdmin}
          namespaces={namespaces}
          groups={dir.groups}
          isFederated={isFederated}
          grantMaxDepth={grantMaxDepth}
          onDone={async (userId) => { setInviting(false); await reload(); if (userId) setOpen(userId); }}
        />
      )}
      {resetTarget && (
        <ResetPasswordModal user={resetTarget} onClose={() => setResetTarget(null)} onDone={() => setResetTarget(null)} />
      )}
      {(error || loadError) && <div className="admin-error">{error || loadError}</div>}

      <div className="grants-user-list">
        {people.map((p) => (
          <PersonCard
            key={p.user.id}
            person={p}
            open={open === p.user.id}
            onToggle={() => { setOpen(open === p.user.id ? null : p.user.id); setError(''); }}
            isSuperAdmin={isSuperAdmin}
            namespaces={namespaces}
            groups={dir.groups}
            grantMaxDepth={grantMaxDepth}
            canReset={isSuperAdmin && userProvider === 'local' && p.user.role !== 'superadmin'}
            run={run}
            onReset={() => setResetTarget(p.user)}
            onDeleted={() => setOpen(null)}
          />
        ))}
        {people.length === 0 && <div className="admin-hint">Nobody matches that.</div>}
      </div>
    </div>
  );
}

function PersonCard({ person, open, onToggle, isSuperAdmin, namespaces, groups, grantMaxDepth, canReset, run, onReset, onDeleted }) {
  const u = person.user;
  const isSuper = u.role === 'superadmin';
  const summary = accessSummary(person);

  const setSuper = (on) => {
    const role = on ? 'superadmin' : (person.adminOf.length ? 'admin' : 'collaborator');
    if (!confirm(on ? `Make ${name(u)} a super-admin? They will manage users, groups and every namespace.` : `Remove super-admin from ${name(u)}?`)) return;
    run(() => adminUpdateRole(u.id, role));
  };
  const remove = () => {
    if (!confirm(`Delete ${name(u)}? Their access is removed too. Their notes stay.`)) return;
    run(async () => { await adminDeleteUser(u.id); onDeleted(); });
  };

  const groupOptions = groups.filter((g) => !person.groups.some((m) => m.id === g.id)).map((g) => ({ value: String(g.id), label: g.name }));
  const adminOptions = namespaces.filter((ns) => !person.adminOf.includes(ns)).map((ns) => ({ value: ns, label: ns }));

  return (
    <div className={`grants-user-card${open ? ' expanded' : ''}`} data-testid="adm-person">
      <div className="grants-user-header" onClick={onToggle} role="button" aria-expanded={open}>
        <div className="grants-user-info">
          <div className="grants-user-avatar">{name(u).slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="grants-user-name">
              {name(u)}
              {isSuper && <span className="role-badge superadmin adm-role">Super-admin</span>}
              {!isSuper && person.adminOf.length > 0 && <span className="role-badge admin adm-role">Admin of {person.adminOf.join(', ')}</span>}
            </div>
            <div className="grants-user-email">{u.email}</div>
          </div>
        </div>
        <div className="grants-user-summary">
          {summary ? <span className="grants-count">{summary}</span> : <span className="grants-none">No access yet</span>}
          <span className="grants-chevron">{open ? '▲' : '▼'}</span>
        </div>
      </div>

      {open && (
        <div className="grants-user-body adm-person-body">
          {isSuperAdmin && (
            <section className="adm-sec">
              <h4>Role</h4>
              <label className="adm-check">
                <input type="checkbox" checked={isSuper} onChange={(e) => setSuper(e.target.checked)} data-testid="adm-super" />
                Super-admin: manages people, groups and every namespace
              </label>
              <p className="admin-hint adm-note">Managing is not reading: a super-admin still needs access below to open notes.</p>
            </section>
          )}

          {isSuperAdmin && (
            <section className="adm-sec">
              <h4>Groups</h4>
              <div className="adm-chips">
                {person.groups.map((g) => (
                  <Chip key={g.id} removeLabel={`Remove from ${g.name}`} onRemove={() => run(() => adminRemoveGroupUser(g.id, u.id))}>{g.name}</Chip>
                ))}
                {person.groups.length === 0 && <span className="admin-hint">In no group.</span>}
                <PickToAdd placeholder={groups.length ? 'Add to a group…' : ''} options={groupOptions} testId="adm-add-group"
                  onPick={(id) => run(() => adminAddGroupUser(Number(id), u.id))} />
              </div>
              {groups.length === 0 && <p className="admin-hint adm-note">No groups yet. Create one in the Groups tab.</p>}
            </section>
          )}

          <section className="adm-sec">
            <h4>Admin of</h4>
            {isSuper ? (
              <p className="admin-hint adm-note">Super-admins manage every namespace.</p>
            ) : (
              <div className="adm-chips">
                {person.adminOf.map((ns) => (
                  <Chip key={ns} tone="admin" removeLabel={`Stop being admin of ${ns}`}
                    onRemove={() => { if (confirm(`Remove ${name(u)} as admin of ${ns}? Their direct access stays.`)) run(() => adminRemoveNamespaceAdmin(u.id, ns)); }}>{ns}</Chip>
                ))}
                {person.adminOf.length === 0 && <span className="admin-hint">No namespace.</span>}
                <PickToAdd placeholder="Make admin of…" options={adminOptions} testId="adm-add-admin"
                  onPick={(ns) => run(() => adminAddNamespaceAdmin(u.id, ns))} />
              </div>
            )}
          </section>

          <section className="adm-sec">
            <h4>Direct access</h4>
            <div className="grants-list">
              {person.direct.map((g) => (
                <div key={g.id} className="grants-item">
                  <div className="grants-item-path">
                    <span className="grants-item-ns">{g.namespace}</span>
                    <span className="grants-item-sep">/</span>
                    <code>{pathLabel(g.path)}</code>
                  </div>
                  <div className="grants-item-actions">
                    <PermToggle permission={g.permission} onToggle={() => run(() => adminUpdateGrant(g.id, g.permission === 'write' ? 'read' : 'write'))} />
                    <button className="share-revoke-btn" onClick={() => run(() => adminDeleteGrant(g.id))} title="Remove this access" aria-label="Remove this access">×</button>
                  </div>
                </div>
              ))}
              {person.direct.length === 0 && <span className="admin-hint">None. {person.groups.length ? 'Their access comes from groups.' : ''}</span>}
            </div>
            <AddAccessRow namespaces={namespaces} grantMaxDepth={grantMaxDepth} label="+ Give access"
              onAdd={(ns, path, perm) => run(() => adminCreateGrant(u.id, ns, path, perm))} />
          </section>

          <section className="adm-sec">
            <h4>Can reach</h4>
            {person.access.length === 0 ? (
              <span className="admin-hint">Nothing yet. They can sign in but will see no namespaces.</span>
            ) : (
              <table className="adm-reach" data-testid="adm-reach">
                <tbody>
                  {person.access.map((r) => (
                    <tr key={`${r.namespace}/${r.path}`}>
                      <td><span className="grants-item-ns">{r.namespace}</span> <span className="grants-item-sep">/</span> <code>{pathLabel(r.path)}</code></td>
                      <td>{r.permission === 'write' ? 'Can edit' : 'Can view'}</td>
                      <td className="adm-via">via {viaLabel(r.via)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {isSuperAdmin && (
            <div className="adm-person-actions">
              {canReset && <button className="admin-action-btn" onClick={onReset}>Reset password</button>}
              <button className="admin-action-btn danger" onClick={remove}>Delete person</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AddAccessRow({ namespaces, grantMaxDepth, onAdd, label, lockedNs, subjectPicker, ready = true }) {
  const [ns, setNs] = useState(lockedNs || '');
  const [path, setPath] = useState('/');
  const [perm, setPerm] = useState('write');
  const submit = (e) => {
    e.preventDefault();
    const target = lockedNs || ns;
    if (!target) return;
    onAdd(target, path || '/', perm);
    if (!lockedNs) setNs('');
    setPath('/');
  };
  const target = lockedNs || ns;
  return (
    <form className="grants-add-row adm-add-row" onSubmit={submit}>
      {subjectPicker}
      {!lockedNs && (
        <select value={ns} onChange={(e) => { setNs(e.target.value); setPath('/'); }} aria-label="Namespace">
          <option value="">Namespace…</option>
          {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      )}
      <PathPicker namespace={target} value={path} onChange={setPath} maxDepth={grantMaxDepth} />
      <select value={perm} onChange={(e) => setPerm(e.target.value)} aria-label="Permission">
        <option value="write">Can edit</option>
        <option value="read">Can view</option>
      </select>
      <button type="submit" disabled={!target || !ready}>{label}</button>
    </form>
  );
}

// Add a person. Nothing beyond the account itself is required from a
// super-admin: groups and namespace access are both optional, so a team run
// entirely through groups never has to pick a namespace here.
function InviteForm({ isSuperAdmin, namespaces, groups, isFederated, grantMaxDepth, onDone }) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [superAdmin, setSuperAdmin] = useState(false);
  const [groupIds, setGroupIds] = useState([]);
  const [ns, setNs] = useState(isSuperAdmin ? '' : (namespaces[0] || ''));
  const [path, setPath] = useState('/');
  const [perm, setPerm] = useState('write');
  const [makeAdmin, setMakeAdmin] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const role = superAdmin ? 'superadmin' : (makeAdmin && ns ? 'admin' : 'collaborator');
      // A namespace admin's invite must name one of their namespaces, and the
      // server grants it (whole namespace, can edit) as part of the invite.
      // A super-admin's invite carries none; access is added below exactly as
      // chosen, so the path and permission are honoured.
      const user = await adminInviteUser(email, isFederated ? '' : username, isFederated ? '' : password, role, isSuperAdmin ? undefined : ns);
      const follow = [];
      if (ns && isSuperAdmin) {
        follow.push(adminCreateGrant(user.id, ns, path || '/', perm));
        if (makeAdmin && !superAdmin) follow.push(adminAddNamespaceAdmin(user.id, ns));
      }
      for (const id of groupIds) follow.push(adminAddGroupUser(id, user.id));
      const results = await Promise.allSettled(follow);
      if (!isSuperAdmin && (perm === 'read' || (path && path !== '/'))) {
        const mine = (await adminListGrants({ user_id: user.id })) || [];
        const g = mine.find((x) => x.namespace === ns);
        if (g) {
          if (path && path !== '/') {
            await adminDeleteGrant(g.id);
            await adminCreateGrant(user.id, ns, path, perm);
          } else {
            await adminUpdateGrant(g.id, perm);
          }
        }
      }
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        setError(`${name(user)} was added, but ${failed.length} step${failed.length === 1 ? '' : 's'} failed: ${failed[0].reason?.message || ''}`);
        setBusy(false);
        return;
      }
      onDone(user.id);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  };

  const toggleGroup = (id) => setGroupIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <form className="adm-invite" onSubmit={submit} data-testid="adm-invite">
      {error && <div className="admin-error">{error}</div>}
      <div className="adm-invite-step">
        <h4>Account</h4>
        {isFederated && (
          <p className="admin-hint adm-note">
            Identity comes from your sign-in provider, so only the email is needed. Name and picture
            are filled in on first sign-in.
          </p>
        )}
        <div className="adm-fields">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          {!isFederated && <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required />}
          {!isFederated && <input type="password" name="new-user-password" placeholder="Temporary password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />}
        </div>
        {isSuperAdmin && (
          <label className="adm-check">
            <input type="checkbox" checked={superAdmin} onChange={(e) => setSuperAdmin(e.target.checked)} />
            Super-admin (manages people, groups and every namespace)
          </label>
        )}
      </div>

      {isSuperAdmin && groups.length > 0 && (
        <div className="adm-invite-step">
          <h4>Groups <span className="adm-optional">optional</span></h4>
          <div className="adm-chips">
            {groups.map((g) => (
              <label key={g.id} className={`adm-chip adm-chip-pick${groupIds.includes(g.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
                {g.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="adm-invite-step">
        <h4>Namespace access {isSuperAdmin && <span className="adm-optional">optional</span>}</h4>
        <div className="grants-add-row adm-add-row">
          <select value={ns} onChange={(e) => { setNs(e.target.value); setPath('/'); }} required={!isSuperAdmin} aria-label="Namespace">
            {isSuperAdmin && <option value="">None, or only through groups</option>}
            {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {ns && <PathPicker namespace={ns} value={path} onChange={setPath} maxDepth={grantMaxDepth} />}
          {ns && (
            <select value={perm} onChange={(e) => setPerm(e.target.value)} aria-label="Permission">
              <option value="write">Can edit</option>
              <option value="read">Can view</option>
            </select>
          )}
        </div>
        {ns && !superAdmin && (
          <label className="adm-check">
            <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} />
            Also make them admin of {ns}
          </label>
        )}
      </div>

      <div className="adm-invite-actions">
        <button type="submit" disabled={busy}>{busy ? 'Adding…' : 'Add person'}</button>
      </div>
    </form>
  );
}

function ResetPasswordModal({ user, onClose, onDone }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (pw.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (pw !== pw2) { setError('Passwords do not match.'); return; }
    setLoading(true);
    try { await adminResetPassword(user.id, pw); onDone(); } catch (err) { setError(err.message); } finally { setLoading(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Reset password: {name(user)}</h3>
        <p className="admin-hint" style={{ marginTop: 0 }}>
          They will be forced to choose a new password on their next login.
          Send the temporary password over a secure channel.
        </p>
        <form onSubmit={handleSubmit}>
          {error && <div className="admin-error">{error}</div>}
          <div className="admin-form-row">
            <input ref={inputRef} type="password" placeholder="New temporary password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required />
          </div>
          <div className="admin-form-row">
            <input type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
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

// ---------------------------------------------------------------- Namespaces

export function NamespacesTab({ isSuperAdmin, namespaces, grantMaxDepth, directory }) {
  const { dir, error: loadError, reload } = directory;
  const { error, run } = useAction(reload);
  const [open, setOpen] = useState(namespaces.length === 1 ? namespaces[0] : null);

  if (!namespaces.length) return <div className="admin-section">No namespaces to manage.</div>;
  if (!dir) return <div className="admin-section">{loadError || 'Loading…'}</div>;

  return (
    <div className="admin-section">
      <div className="admin-section-header"><h3>Namespaces ({namespaces.length})</h3></div>
      <p className="admin-hint adm-intro">
        Who can reach each namespace, directly or through a group, and who administers it.
      </p>
      {(error || loadError) && <div className="admin-error">{error || loadError}</div>}
      <div className="grants-user-list">
        {namespaces.map((ns) => (
          <NamespaceCard key={ns} ns={ns} view={dir.byNamespace(ns)} groups={dir.groups} people={dir.people}
            open={open === ns} onToggle={() => setOpen(open === ns ? null : ns)}
            isSuperAdmin={isSuperAdmin} grantMaxDepth={grantMaxDepth} run={run} />
        ))}
      </div>
    </div>
  );
}

function NamespaceCard({ ns, view, groups, people, open, onToggle, isSuperAdmin, grantMaxDepth, run }) {
  const [subject, setSubject] = useState('');
  const admins = view.members.filter((m) => m.isAdmin);
  const groupCount = new Set(view.groups.map((g) => g.group.id)).size;
  const summary = [
    `${view.members.length} ${view.members.length === 1 ? 'person' : 'people'}`,
    groupCount ? `${groupCount} group${groupCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ');

  const give = (_ns, path, perm) => {
    if (!subject) return;
    const [kind, id] = subject.split(':');
    run(() => (kind === 'g' ? adminCreateGroupGrant(Number(id), ns, path, perm) : adminCreateGrant(Number(id), ns, path, perm)));
    setSubject('');
  };

  return (
    <div className={`grants-user-card${open ? ' expanded' : ''}`} data-testid="adm-namespace">
      <div className="grants-user-header" onClick={onToggle} role="button" aria-expanded={open}>
        <div className="grants-user-info">
          <div className="grants-user-avatar adm-ns-avatar">{ns.slice(0, 1).toUpperCase()}</div>
          <div>
            <div className="grants-user-name">{ns}</div>
            <div className="grants-user-email">{admins.length ? `Admin: ${admins.map((m) => name(m.person.user)).join(', ')}` : 'No admin'}</div>
          </div>
        </div>
        <div className="grants-user-summary">
          <span className={view.members.length ? 'grants-count' : 'grants-none'}>{summary}</span>
          <span className="grants-chevron">{open ? '▲' : '▼'}</span>
        </div>
      </div>
      {open && (
        <div className="grants-user-body">
          <section className="adm-sec">
            <h4>People</h4>
            {view.members.length === 0 && <span className="admin-hint">Nobody can reach {ns} yet.</span>}
            <div className="grants-list">
              {view.members.map(({ person, rows, isAdmin }) => {
                const direct = person.direct.filter((g) => g.namespace === ns);
                const isSuper = person.user.role === 'superadmin';
                return (
                  <div key={person.user.id} className="grants-item adm-ns-row">
                    <div className="adm-ns-who">
                      <span className="grants-user-name">{name(person.user)}</span>
                      {isAdmin && <span className="role-badge admin adm-role">Admin</span>}
                    </div>
                    <div className="adm-ns-rows">
                      {rows.map((r) => {
                        const d = direct.find((g) => (g.path || '/') === r.path);
                        return (
                          <div key={r.path} className="adm-ns-access">
                            <code>{pathLabel(r.path)}</code>
                            {d ? (
                              <PermToggle permission={d.permission} onToggle={() => run(() => adminUpdateGrant(d.id, d.permission === 'write' ? 'read' : 'write'))} />
                            ) : (
                              <span className="adm-perm-static">{r.permission === 'write' ? 'Can edit' : 'Can view'}</span>
                            )}
                            <span className="adm-via">via {viaLabel(r.via)}</span>
                            {d && <button className="share-revoke-btn" onClick={() => run(() => adminDeleteGrant(d.id))} title="Remove direct access" aria-label="Remove direct access">×</button>}
                          </div>
                        );
                      })}
                    </div>
                    {!isSuper && (
                      isAdmin ? (
                        <button className="admin-action-btn" onClick={() => { if (confirm(`Remove ${name(person.user)} as admin of ${ns}?`)) run(() => adminRemoveNamespaceAdmin(person.user.id, ns)); }}>Remove admin</button>
                      ) : (
                        <button className="admin-action-btn" onClick={() => run(() => adminAddNamespaceAdmin(person.user.id, ns))}>Make admin</button>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {isSuperAdmin && (
            <section className="adm-sec">
              <h4>Groups with access</h4>
              {view.groups.length === 0 && <span className="admin-hint">No group has access to {ns}.</span>}
              <div className="grants-list">
                {view.groups.map(({ group, grant }) => (
                  <div key={grant.id} className="grants-item">
                    <div className="grants-item-path">
                      <span className="grants-item-ns">{group.name}</span>
                      <span className="grants-item-sep">/</span>
                      <code>{pathLabel(grant.path)}</code>
                    </div>
                    <div className="grants-item-actions">
                      <PermToggle permission={grant.permission} onToggle={() => run(() => adminUpdateGroupGrant(grant.id, grant.permission === 'write' ? 'read' : 'write'))} />
                      <button className="share-revoke-btn" onClick={() => run(() => adminDeleteGroupGrant(grant.id))} title="Remove this group's access" aria-label="Remove this group's access">×</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="adm-sec">
            <h4>Give access</h4>
            <AddAccessRow lockedNs={ns} grantMaxDepth={grantMaxDepth} label="+ Give access" onAdd={give} ready={!!subject}
              subjectPicker={(
                <select value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Person or group" data-testid="adm-ns-subject">
                  <option value="">{isSuperAdmin && groups.length ? 'Person or group…' : 'Person…'}</option>
                  {isSuperAdmin && groups.length > 0 && (
                    <optgroup label="Groups">
                      {groups.map((g) => <option key={g.id} value={`g:${g.id}`}>{g.name}</option>)}
                    </optgroup>
                  )}
                  <optgroup label="People">
                    {people.map((p) => <option key={p.user.id} value={`u:${p.user.id}`}>{name(p.user)}</option>)}
                  </optgroup>
                </select>
              )} />
          </section>
        </div>
      )}
    </div>
  );
}
