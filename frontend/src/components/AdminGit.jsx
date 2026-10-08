import { useState, useEffect, useCallback } from 'react';
import {
  getWorkspaceStatus,
  adminListWorkspaces,
  adminSaveWorkspace,
  adminDeleteWorkspace,
  adminListWorkspaceGroups,
  adminSaveWorkspaceGroup,
  adminDeleteWorkspaceGroup,
  adminCreateWorkspaceInGroup,
} from '../api.js';
import { gitBackupFor } from '../adminDirectory.js';

// Git backup, inside the Namespaces tab. It used to be its own "Git Workspaces"
// tab whose "groups" shared a name with the access Groups tab, while a
// workspace was really just a namespace plus its git remote. Now a namespace's
// backup sits on its card, a namespace is added with its backup in one step,
// and a shared remote + token is a "git connection".
//
// The server API keeps its names: a workspace is a namespace's git config and
// a workspace group is a git connection.
//
// None of this is shown on the plain-files backend (every setup.sh install):
// that server ignores per-namespace remotes and refuses to create namespaces,
// because they come from mdnest.conf and git-sync does the backup.

export function useGit(isSuperAdmin) {
  const [status, setStatus] = useState(null); // { mirroring, encryption }
  const [workspaces, setWorkspaces] = useState([]);
  const [connections, setConnections] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!isSuperAdmin) return;
    const s = await getWorkspaceStatus();
    setStatus(s);
    if (!s.mirroring) return;
    try {
      const [ws, cs] = await Promise.all([adminListWorkspaces(), adminListWorkspaceGroups()]);
      setWorkspaces(ws || []);
      setConnections(cs || []);
    } catch (e) {
      setError(e.message);
    }
  }, [isSuperAdmin]);
  useEffect(() => { load(); }, [load]);

  const run = useCallback(async (fn) => {
    setError('');
    let ok = true;
    try { await fn(); } catch (e) { setError(e.message || 'That did not work'); ok = false; }
    await load();
    return ok;
  }, [load]);

  return { status, mirroring: !!status?.mirroring, workspaces, connections, error, run, reload: load };
}

// The honest sync state of a namespace's backup. "ok" only after a sync that
// succeeded; never synced, or the remote repository not created yet, is
// "waiting", not an error.
function SyncState({ ws }) {
  if (!ws.git_enabled) return <span className="adm-git-state off">Off</span>;
  const err = ws.last_sync_error;
  if (err && err.startsWith('pending:')) return <span className="adm-git-state" title={err}>Waiting for first sync</span>;
  if (err) return <span className="adm-git-state bad" title={err}>Sync failing</span>;
  if (ws.last_sync_at) return <span className="adm-git-state good" title={`Last synced ${new Date(ws.last_sync_at).toLocaleString()}`}>Synced</span>;
  return <span className="adm-git-state" title="No successful sync yet">Waiting for first sync</span>;
}

// Only promise the notes are kept when a synced copy really exists.
function removeConfirmText(ns, ws) {
  const synced = ws.git_enabled && ws.last_sync_at && !ws.last_sync_error;
  const base = `Remove "${ns}"? Everyone's access to it and its admins are removed.`;
  return synced
    ? `${base} The namespace leaves mdnest; its notes stay in the git repository.`
    : `${base} It has no synced git copy, so its notes are NOT deleted and the folder stays on the server.`;
}

const emptyRepo = { transport: 'https', remote_url: '', username: 'oauth2', branch: 'main', known_hosts: '', credential: '' };

function RepoFields({ form, set, keepToken }) {
  return (
    <div className="adm-git-fields">
      <div className="adm-git-row">
        <select value={form.transport} onChange={set('transport')} aria-label="Protocol">
          <option value="https">HTTPS</option>
          <option value="ssh">SSH</option>
        </select>
        <input placeholder={form.transport === 'ssh' ? 'git@github.com:acme/notes.git' : 'https://github.com/acme/notes.git'}
          value={form.remote_url} onChange={set('remote_url')} aria-label="Repository" />
      </div>
      <div className="adm-git-row">
        {form.transport === 'https' && <input placeholder="username (oauth2)" value={form.username} onChange={set('username')} aria-label="Username" />}
        <input placeholder="branch (main)" value={form.branch} onChange={set('branch')} aria-label="Branch" />
      </div>
      {form.transport === 'ssh' && (
        <textarea rows={2} placeholder="known_hosts line (github.com ssh-ed25519 AAAA...)" value={form.known_hosts} onChange={set('known_hosts')} aria-label="Known hosts" />
      )}
      <input type="password" value={form.credential} onChange={set('credential')} aria-label="Token or key"
        placeholder={form.transport === 'ssh'
          ? (keepToken ? 'private key (leave blank to keep)' : 'private key')
          : (keepToken ? 'access token (leave blank to keep)' : 'access token with write access to this repository')} />
    </div>
  );
}

const repoPayload = (form) => {
  const p = {
    git_enabled: true,
    transport: form.transport,
    remote_url: form.remote_url.trim(),
    username: form.username.trim(),
    branch: form.branch.trim(),
    known_hosts: form.known_hosts,
  };
  if (form.credential) p.credential = form.credential;
  return p;
};

// Choose where a namespace backs up: one of the saved git connections (repo
// <base>/<namespace>.git), or a repository of its own.
function BackupChoice({ ns, connections, form, setForm }) {
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <select value={form.via} onChange={set('via')} aria-label="Back up to" data-testid="adm-git-via">
        {connections.map((c) => (
          <option key={c.id} value={`c:${c.id}`}>{c.name}: {(c.base_url || '').replace(/\/+$/, '')}/{ns || 'name'}.git</option>
        ))}
        <option value="own">Its own repository…</option>
      </select>
      {form.via === 'own' && <RepoFields form={form} set={set} />}
    </>
  );
}

const startChoice = (connections) => ({ ...emptyRepo, via: connections.length ? `c:${connections[0].id}` : 'own' });

async function saveChoice(ns, form) {
  if (form.via.startsWith('c:')) return adminCreateWorkspaceInGroup(ns, Number(form.via.slice(2)));
  return adminSaveWorkspace({ namespace: ns, ...repoPayload(form) });
}

// The "Git backup" section of one namespace card.
export function GitBackup({ ns, git, onRemoved }) {
  const { workspaces, connections, run } = git;
  const backup = gitBackupFor(ns, workspaces, connections);
  const [mode, setMode] = useState(null); // 'setup' | 'edit'
  const [form, setForm] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const openSetup = () => { setForm(startChoice(connections)); setMode('setup'); };
  const openEdit = () => {
    const w = backup.ws;
    setForm({ transport: w.transport || 'https', remote_url: w.remote_url || '', username: w.username || 'oauth2', branch: w.branch || 'main', known_hosts: w.known_hosts || '', credential: '' });
    setMode('edit');
  };
  const close = () => { setMode(null); setForm(null); };
  const submit = async () => {
    const ok = await run(() => (mode === 'setup' ? saveChoice(ns, form) : adminSaveWorkspace(repoPayload(form), backup.ws.id)));
    if (ok) close();
  };
  const toggle = () => run(() => adminSaveWorkspace(backup.kind === 'own'
    ? { ...repoPayload({ ...emptyRepo, ...backup.ws, credential: '' }), git_enabled: !backup.ws.git_enabled }
    : { git_enabled: !backup.ws.git_enabled }, backup.ws.id));
  const remove = async () => {
    if (!confirm(removeConfirmText(ns, backup.ws))) return;
    if (await run(() => adminDeleteWorkspace(backup.ws.id))) onRemoved?.();
  };

  return (
    <section className="adm-sec" data-testid="adm-git">
      <h4>Git backup</h4>
      {backup.kind === 'none' && !mode && (
        <div className="adm-git-line">
          <span className="admin-hint">Not backed up to git.</span>
          <button className="admin-action-btn" onClick={openSetup}>Set up backup</button>
        </div>
      )}
      {backup.kind === 'default' && (
        <div className="adm-git-line">
          <code className="adm-git-repo" title={backup.repo}>{backup.repo}</code>
          <span className="adm-via">server default, set by the deployment</span>
        </div>
      )}
      {(backup.kind === 'connection' || backup.kind === 'own') && !mode && (
        <div className="adm-git-line">
          <code className="adm-git-repo" title={backup.repo}>{backup.repo}</code>
          {backup.kind === 'connection' && <span className="adm-via">via {backup.connection.name}</span>}
          <SyncState ws={backup.ws} />
          <span className="adm-git-actions">
            {backup.kind === 'own' && <button className="admin-action-btn" onClick={openEdit}>Edit</button>}
            <button className="admin-action-btn" onClick={toggle}>{backup.ws.git_enabled ? 'Pause' : 'Resume'}</button>
            <button className="admin-action-btn danger" onClick={remove}>Remove namespace</button>
          </span>
        </div>
      )}
      {mode && (
        <div className="adm-git-form">
          {mode === 'setup'
            ? <BackupChoice ns={ns} connections={connections} form={form} setForm={setForm} />
            : <RepoFields form={form} set={set} keepToken={backup.ws?.has_credential} />}
          <div className="adm-git-row end">
            <button className="modal-btn" onClick={close}>Cancel</button>
            <button className="modal-btn-primary" onClick={submit}>Save</button>
          </div>
        </div>
      )}
    </section>
  );
}

// "+ Add namespace": a new namespace and its git backup, in one step. A backup
// is required: on this backend the git repository is what makes a namespace
// created here durable.
export function AddNamespace({ git, onAdded, onCancel }) {
  const [name, setName] = useState('');
  const [form, setForm] = useState(() => startChoice(git.connections));
  const submit = async () => {
    const ns = name.trim();
    if (!ns) return;
    if (await git.run(() => saveChoice(ns, form))) onAdded(ns);
  };
  return (
    <div className="adm-invite adm-git-add" data-testid="adm-add-ns">
      <h4>Add a namespace</h4>
      <div className="adm-git-fields">
        <input placeholder="name, e.g. team-notes" value={name} onChange={(e) => setName(e.target.value)} aria-label="Namespace name" autoFocus />
        <span className="admin-hint adm-note">Backed up to</span>
        <BackupChoice ns={name.trim()} connections={git.connections} form={form} setForm={setForm} />
      </div>
      <div className="adm-git-row end">
        <button className="modal-btn" onClick={onCancel}>Cancel</button>
        <button className="modal-btn-primary" onClick={submit} disabled={!name.trim()}>Add namespace</button>
      </div>
    </div>
  );
}

// Saved git connections: one host + token that many namespaces back up
// through, each to <base>/<namespace>.git.
export function GitConnections({ git }) {
  const { connections, workspaces, run } = git;
  const empty = { name: '', transport: 'https', base_url: '', username: 'oauth2', branch: 'main', known_hosts: '', credential: '' };
  const [form, setForm] = useState(null);
  const [editId, setEditId] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const open = (c) => {
    setEditId(c ? c.id : null);
    setForm(c ? { name: c.name, transport: c.transport, base_url: c.base_url, username: c.username, branch: c.branch, known_hosts: c.known_hosts || '', credential: '' } : empty);
  };
  const close = () => { setForm(null); setEditId(null); };
  const save = async () => {
    const p = { name: form.name.trim(), transport: form.transport, base_url: form.base_url.trim(), username: form.username.trim(), branch: form.branch.trim(), known_hosts: form.known_hosts };
    if (form.credential) p.credential = form.credential;
    if (await run(() => adminSaveWorkspaceGroup(p, editId || undefined))) close();
  };
  const del = (c, used) => {
    if (!confirm(`Delete the connection "${c.name}"? ${used.length ? `The ${used.length} namespace(s) backed up through it (${used.join(', ')}) are removed from mdnest too, with their access. Those with a synced git copy keep their notes in git; the others keep their notes on the server.` : 'No namespace uses it.'}`)) return;
    run(() => adminDeleteWorkspaceGroup(c.id));
  };

  return (
    <div className="adm-git-connections" data-testid="adm-git-connections">
      <div className="admin-section-header">
        <h3>Git connections</h3>
        {!form && <button className="admin-action-btn" onClick={() => open(null)}>+ Add connection</button>}
      </div>
      <p className="admin-hint adm-intro">
        A git host and token saved once. Each namespace backed up through it gets its own repository, named after the namespace.
      </p>
      {form && (
        <div className="adm-invite adm-git-form">
          <div className="adm-git-fields">
            <input placeholder="name, e.g. GitHub acme" value={form.name} onChange={set('name')} aria-label="Connection name" />
            <div className="adm-git-row">
              <select value={form.transport} onChange={set('transport')} aria-label="Protocol">
                <option value="https">HTTPS</option><option value="ssh">SSH</option>
              </select>
              <input placeholder={form.transport === 'ssh' ? 'git@github.com:acme' : 'https://github.com/acme'} value={form.base_url} onChange={set('base_url')} aria-label="Address" />
            </div>
            <div className="adm-git-row">
              {form.transport === 'https' && <input placeholder="username (oauth2)" value={form.username} onChange={set('username')} aria-label="Username" />}
              <input placeholder="branch (main)" value={form.branch} onChange={set('branch')} aria-label="Branch" />
            </div>
            {form.transport === 'ssh' && <textarea rows={2} placeholder="known_hosts line" value={form.known_hosts} onChange={set('known_hosts')} aria-label="Known hosts" />}
            <input type="password" value={form.credential} onChange={set('credential')} aria-label="Token or key"
              placeholder={editId ? 'token or key (leave blank to keep)' : 'token or key that can create and push repositories'} />
          </div>
          <div className="adm-git-row end">
            <button className="modal-btn" onClick={close}>Cancel</button>
            <button className="modal-btn-primary" onClick={save}>{editId ? 'Save' : 'Add connection'}</button>
          </div>
        </div>
      )}
      {connections.length === 0 && !form && <span className="admin-hint">No connections yet. A namespace can still back up to a repository of its own.</span>}
      <div className="grants-list">
        {connections.map((c) => {
          const used = [...workspaces.filter((w) => w.group_id === c.id).map((w) => w.namespace), ...(c.implicit_namespaces || [])];
          const provisioned = c.source === 'provisioned';
          return (
            <div key={c.id} className="grants-item">
              <div className="grants-item-path adm-git-conn">
                <span className="grants-item-ns">{c.name}</span>
                <code title={c.base_url}>{c.base_url}</code>
                <span className="adm-via">
                  {used.length ? `used by ${used.join(', ')}` : 'not used yet'}
                  {!c.has_credential && ' · no token'}
                </span>
              </div>
              <div className="grants-item-actions">
                {provisioned
                  ? <span className="adm-via" title="Set by the deployment (GIT_REMOTE_URL). Namespaces can use it; it cannot be edited here.">set by deployment</span>
                  : <>
                      <button className="admin-action-btn" onClick={() => open(c)}>Edit</button>
                      <button className="admin-action-btn danger" onClick={() => del(c, used)}>Delete</button>
                    </>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
