import { useState, useEffect, useCallback } from 'react';
import { changePassword, listTokens, createToken, revokeToken, restartServer, readBootId, waitForRestart } from '../api.js';

// Derive server URL from current browser location
function getServerUrl() {
  return window.location.origin;
}

// A code snippet with a one-click copy button. Uses the async Clipboard API
// when available (HTTPS / localhost) and falls back to execCommand for
// non-secure contexts (a LAN install served over plain http), so copy works
// everywhere mdnest runs.
function CodeBlock({ code, label }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code);
      } else {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked — no-op */ }
  };
  return (
    <div className="settings-code">
      {label && <div className="code-label">{label}</div>}
      <button
        type="button"
        className={`settings-copy-btn${copied ? ' copied' : ''}`}
        onClick={copy}
        title={copied ? 'Copied!' : 'Copy'}
        aria-label={copied ? 'Copied' : 'Copy to clipboard'}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        )}
      </button>
      <pre>{code}</pre>
    </div>
  );
}

function Settings({ onClose, userProvider, themePreference, resolvedTheme, onChangeTheme, serverDefaultTheme, serverVersion, canRestart }) {
  const [tab, setTab] = useState('tokens');
  // Hide Credentials + 2FA in any federated mode — identity lives with the
  // external provider (Firebase Auth / corporate SSO IdP), not in mdnest's
  // users table. Keeping the tab visible would be misleading and the
  // change-password endpoint refuses these accounts anyway.
  const passwordEnabled = userProvider !== 'firebase' && userProvider !== 'sso';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="modal-close-btn" onClick={onClose}>x</button>
        </div>
        <div className="settings-tabs">
          <button className={tab === 'appearance' ? 'active' : ''} onClick={() => setTab('appearance')}>Appearance</button>
          <button className={tab === 'tokens' ? 'active' : ''} onClick={() => setTab('tokens')}>API Tokens</button>
          <button className={tab === 'cli' ? 'active' : ''} onClick={() => setTab('cli')}>CLI</button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>MCP</button>
          <button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>API</button>
          {passwordEnabled && (
            <button className={tab === 'password' ? 'active' : ''} onClick={() => setTab('password')}>Credentials</button>
          )}
          {canRestart && (
            <button className={tab === 'server' ? 'active' : ''} onClick={() => setTab('server')}>Server</button>
          )}
        </div>
        {tab === 'appearance' && (
          <AppearanceTab
            preference={themePreference}
            resolved={resolvedTheme}
            serverDefault={serverDefaultTheme}
            onChange={onChangeTheme}
          />
        )}
        {tab === 'tokens' && <TokensTab />}
        {tab === 'cli' && <CliTab serverVersion={serverVersion} />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'api' && <ApiTab />}
        {tab === 'password' && passwordEnabled && <PasswordTab />}
        {tab === 'server' && canRestart && <ServerTab />}
      </div>
    </div>
  );
}

// AppearanceTab owns the full three-way theme choice. The toolbar button only
// flips between dark and light, because one button cannot express three states
// without turning into a menu — so "follow my system" needs a home, and this is
// it.
function AppearanceTab({ preference, resolved, serverDefault, onChange }) {
  const OPTIONS = [
    { value: 'auto', label: 'Match system', hint: 'Follow your operating system setting' },
    { value: 'light', label: 'Light', hint: null },
    { value: 'dark', label: 'Dark', hint: null },
  ];

  return (
    <div className="settings-tab">
      <p className="settings-hint">
        Your choice is saved to your account, not this browser, so it follows you
        to any device you sign in from.
      </p>
      <div className="theme-options">
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`theme-option${preference === o.value ? ' active' : ''}`}
            onClick={() => onChange?.(o.value)}
            aria-pressed={preference === o.value}
          >
            <span className="theme-option-label">{o.label}</span>
            {o.hint && <span className="theme-option-hint">{o.hint}</span>}
          </button>
        ))}
      </div>
      {preference === 'auto' && (
        // Without this the Match-system row gives no feedback at all: the
        // screen may already be the colour the OS asked for, so clicking it
        // looks like nothing happened.
        <p className="settings-hint">
          Your system is currently set to <strong>{resolved}</strong>.
        </p>
      )}
      {serverDefault && serverDefault !== 'auto' && preference === 'auto' && (
        <p className="settings-hint">
          This server suggests <strong>{serverDefault}</strong> for people who have
          not chosen; your setting overrides it.
        </p>
      )}
    </div>
  );
}

function TokensTab() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  const [newToken, setNewToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadTokens = useCallback(async () => {
    try {
      const data = await listTokens();
      setTokens(data || []);
    } catch (e) {
      console.error('Failed to load tokens:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadTokens(); }, [loadTokens]);

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      const data = await createToken(name.trim());
      setNewToken(data.token);
      setName('');
      loadTokens();
    } catch (e) {
      alert('Failed to create token: ' + e.message);
    }
  };

  const handleRevoke = async (id, tokenName) => {
    if (!confirm(`Revoke token "${tokenName}"? Any MCP/API clients using it will stop working.`)) return;
    try {
      await revokeToken(id);
      loadTokens();
    } catch (e) {
      alert('Failed to revoke: ' + e.message);
    }
  };

  const handleCopy = () => {
    if (newToken) {
      const ta = document.createElement('textarea');
      ta.value = newToken;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="settings-content">
      <p className="settings-description">
        Create tokens for CLI, MCP servers, and API clients. Tokens don't expire -- revoke them when no longer needed.
      </p>

      {newToken && (
        <div className="token-created">
          <div className="token-created-label">Token created -- copy it now, it won't be shown again:</div>
          <div className="token-created-value" onClick={handleCopy} style={{ cursor: 'pointer' }} title="Click to copy">
            <code>{newToken}</code>
            <button onClick={(e) => { e.stopPropagation(); handleCopy(); }}>{copied ? 'Copied!' : 'Copy'}</button>
          </div>
          <button className="modal-btn" onClick={() => setNewToken(null)} style={{ marginTop: '0.5rem' }}>Dismiss</button>
        </div>
      )}

      <div className="token-create-row">
        <input
          type="text"
          className="modal-input"
          placeholder="Token name (e.g. my-laptop, Claude MCP)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
        />
        <button className="modal-btn-primary" onClick={handleCreate}>Create</button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading...</p>
      ) : tokens.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No tokens yet. Create one to connect CLI, MCP, or API clients.</p>
      ) : (
        <div className="token-list">
          {tokens.map((t) => (
            <div key={t.id} className="token-item">
              <div className="token-info">
                <span className="token-name">{t.name}</span>
                <span className="token-hint">
                  mdnest_•••••{t.token_suffix || '????'}
                </span>
                <span className="token-date">Created {new Date(t.created_at).toLocaleDateString()}</span>
              </div>
              <button className="token-revoke" onClick={() => handleRevoke(t.id, t.name)}>Revoke</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Copies text without the async Clipboard API when that is unavailable (a LAN
// install over plain http). Returns whether the copy went through.
function copyText(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Creates an API token for the CLI and copies it, so setting up the CLI never
// means switching to the API Tokens tab and back. The token is shown once, as
// in that tab, in case the copy was blocked.
function CliTokenButton() {
  const [token, setToken] = useState(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const day = new Date().toISOString().slice(0, 10);
      const data = await createToken(`CLI ${day}`);
      setToken(data.token);
      setCopied(copyText(data.token));
    } catch (e) {
      setError(e.message || 'Could not create a token');
    } finally {
      setBusy(false);
    }
  };

  if (token) {
    return (
      <div className="token-created cli-token-created">
        <div className="token-created-label">
          {copied
            ? 'Token created and copied. Paste it when the terminal asks for it. It will not be shown again:'
            : 'Token created. Copy it now, it will not be shown again:'}
        </div>
        <div className="token-created-value">
          <code>{token}</code>
          <button onClick={() => setCopied(copyText(token))}>{copied ? 'Copied!' : 'Copy'}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="cli-token-row">
      <button className="modal-btn-primary" onClick={create} disabled={busy}>
        {busy ? 'Creating...' : 'Create a token and copy it'}
      </button>
      {error && <span className="cli-token-error">{error}</span>}
    </div>
  );
}

function CliTab({ serverVersion }) {
  const serverUrl = getServerUrl();
  return (
    <div className="settings-content">
      <h4 className="settings-section-title">mdnest CLI</h4>
      <p className="settings-description">
        Access your notes from any terminal. Read, write, search, and organize notes without leaving the command line.
      </p>

      <div className="settings-info-box">
        <div className="settings-info-label">Your server</div>
        <code>{serverUrl}</code>
      </div>

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">1</span>
          <span>Install the CLI from this server and log in (one command):</span>
        </div>
      </div>
      <CodeBlock code={`curl -fsSL ${serverUrl}/cli/install.sh | bash -s -- ${serverUrl}`} />

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">2</span>
          <span>
            The terminal asks for a token. Create one here, or in the <strong>API Tokens</strong> tab,
            and paste it in. It is not shown as you paste and does not go into your shell history.
          </span>
        </div>
      </div>
      <CliTokenButton />

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">3</span>
          <span>Start using it:</span>
        </div>
      </div>
      <CodeBlock code={`mdnest list                              # list namespaces
mdnest list notes                        # list files in the "notes" namespace
mdnest read notes/path/to/note.md        # read a note
mdnest search notes "query"              # search
mdnest write notes/path.md "text"        # write
echo "text" | mdnest append notes/log.md -        # pipe`} />

      <h4 className="settings-section-title">Keeping it up to date</h4>
      <p className="settings-description">
        The CLI does <strong>not</strong> update itself, and nothing pushes new versions to you —
        it is a script on your machine. If it starts behaving oddly, update it first:
      </p>
      <CodeBlock code={`mdnest update --server ${serverUrl}   # the CLI this server was built with
mdnest version     # check what you are running`} />
      <p className="settings-description">
        Plain <code>mdnest update</code> installs the latest release from GitHub instead, which may not
        be the version this server runs.
      </p>
      <p className="settings-description">
        {serverVersion
          ? <>This server runs <code>v{serverVersion}</code>. If <code>mdnest version</code> reports
            anything older, update — the CLI and the server ship together at the same version.</>
          : <>Compare <code>mdnest version</code> against this server's version, shown in the sidebar footer.</>}
        {' '}From v4.3.2 the CLI tells you itself, in <code>mdnest servers</code> and at login,
        whenever it is behind the server it is talking to.
      </p>

      <h4 className="settings-section-title">Multi-Server</h4>
      <p className="settings-description">
        Manage multiple mdnest servers with @alias paths:
      </p>
      <CodeBlock code={`mdnest login @work ${serverUrl}
mdnest login @personal https://home:3236
mdnest read @work/notes/path.md
mdnest servers                           # list all servers`} />
    </div>
  );
}

function McpTab() {
  const serverUrl = getServerUrl();
  return (
    <div className="settings-content">
      <h4 className="settings-section-title">MCP Server</h4>
      <p className="settings-description">
        The MCP server lets AI assistants (Claude, Cursor, etc.) read, write, search, and organize your notes directly.
      </p>

      <div className="settings-info-box">
        <div className="settings-info-label">Your server</div>
        <code>{serverUrl}</code>
      </div>

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">1</span>
          <span>Create an API token in the <strong>API Tokens</strong> tab</span>
        </div>
        <div className="settings-step">
          <span className="step-num">2</span>
          <span>Install dependencies:</span>
        </div>
      </div>
      <CodeBlock code="cd mcp-server && npm install" />

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">3</span>
          <span>Add to your MCP client config (e.g. Claude Desktop):</span>
        </div>
      </div>
      <CodeBlock code={`{
  "mcpServers": {
    "mdnest": {
      "command": "node",
      "args": ["/path/to/mdnest/mcp-server/index.js"],
      "env": {
        "MDNEST_URL": "${serverUrl}",
        "MDNEST_TOKEN": "<your token>"
      }
    }
  }
}`} />

      <h4 className="settings-section-title">Available Tools</h4>
      <div className="settings-tool-list">
        <div className="settings-tool"><code>list_namespaces</code> -- list mounted namespaces</div>
        <div className="settings-tool"><code>list_tree</code> -- get folder/file tree</div>
        <div className="settings-tool"><code>read_note</code> -- read a note's content</div>
        <div className="settings-tool"><code>write_note</code> -- update an existing note</div>
        <div className="settings-tool"><code>create_note</code> -- create a new note</div>
        <div className="settings-tool"><code>create_folder</code> -- create a folder</div>
        <div className="settings-tool"><code>delete_item</code> -- delete a file or folder</div>
        <div className="settings-tool"><code>move_item</code> -- move/rename a file or folder</div>
        <div className="settings-tool"><code>search_notes</code> -- search note contents</div>
      </div>
    </div>
  );
}

function ApiTab() {
  const serverUrl = getServerUrl();
  return (
    <div className="settings-content">
      <h4 className="settings-section-title">REST API</h4>
      <p className="settings-description">
        All endpoints accept a Bearer token in the Authorization header. Create a token in the API Tokens tab.
      </p>

      <div className="settings-info-box">
        <div className="settings-info-label">API base URL</div>
        <code>{serverUrl}/api</code>
      </div>

      <h4 className="settings-section-title">Authentication</h4>
      <CodeBlock code={`# Use your API token
curl -H "Authorization: Bearer mdnest_your_token_here" \\
  ${serverUrl}/api/namespaces`} />

      <h4 className="settings-section-title">Examples</h4>

      <CodeBlock label="List namespaces" code={`curl -H "Authorization: Bearer $TOKEN" \\
  ${serverUrl}/api/namespaces`} />

      <CodeBlock label="Get file tree" code={`curl -H "Authorization: Bearer $TOKEN" \\
  "${serverUrl}/api/tree?ns=my_notes"`} />

      <CodeBlock label="Read a note" code={`curl -H "Authorization: Bearer $TOKEN" \\
  "${serverUrl}/api/note?ns=my_notes&path=ideas/project.md"`} />

      <CodeBlock label="Create a note" code={`curl -X POST -H "Authorization: Bearer $TOKEN" \\
  -d "# New Note" \\
  "${serverUrl}/api/note?ns=my_notes&path=new-note.md"`} />

      <CodeBlock label="Search" code={`curl -H "Authorization: Bearer $TOKEN" \\
  "${serverUrl}/api/search?ns=my_notes&q=kubernetes"`} />
    </div>
  );
}

function PasswordTab() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (!currentPassword) { setError('Current password is required'); return; }
    if (!newPassword) { setError('New password is required'); return; }
    if (newPassword !== confirmPassword) { setError('New passwords do not match'); return; }
    if (newPassword.length < 6) { setError('New password must be at least 6 characters'); return; }

    setLoading(true);
    try {
      await changePassword(currentPassword, newUsername || '', newPassword);
      setSuccess(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="settings-content">
        <p style={{ color: 'var(--success)', margin: '1rem 0' }}>
          Credentials updated. You need to log in again.
        </p>
        <button
          className="modal-btn-primary"
          onClick={() => { localStorage.removeItem('mdnest_token'); window.location.reload(); }}
        >
          Log in again
        </button>
      </div>
    );
  }

  return (
    <div className="settings-content">
      <form onSubmit={handleSubmit} autoComplete="off">
        {error && <div className="modal-error">{error}</div>}
        <label className="modal-label">Current Password</label>
        <input type="password" name="current-password" className="modal-input" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" autoFocus />
        <label className="modal-label">New Username (leave blank to keep current)</label>
        <input type="text" name="new-username" className="modal-input" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} autoComplete="username" placeholder="Optional" />
        <label className="modal-label">New Password</label>
        <input type="password" name="new-password" className="modal-input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
        <label className="modal-label">Confirm New Password</label>
        <input type="password" name="confirm-password" className="modal-input" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" />
        <div className="modal-actions">
          <button type="submit" className="modal-btn-primary" disabled={loading}>
            {loading ? 'Saving...' : 'Update Credentials'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default Settings;

// ServerTab restarts the backend (superadmin only; the server enforces it).
// It is for a server that is stuck, without needing SSH. It cannot apply a
// change to docker-compose.yml or .env: Docker fixes mounts and environment
// when the container is created, so those still need `docker compose up -d`
// on the server, and the tab says so.
function ServerTab() {
  const [state, setState] = useState('idle'); // idle | confirm | restarting | failed
  const [error, setError] = useState('');

  const restart = async () => {
    setState('restarting');
    setError('');
    try {
      const before = await readBootId();
      await restartServer();
      await waitForRestart(before);
      window.location.reload();
    } catch (e) {
      setError(e.message || 'Restart failed');
      setState('failed');
    }
  };

  return (
    <div className="settings-content" data-testid="settings-server">
      <p className="settings-server-text">
        Restart the mdnest backend. Everyone using this server is disconnected for a few seconds and
        then reconnects on their own. Saved notes are not affected.
      </p>
      <p className="settings-server-text settings-server-muted">
        A restart keeps the same mounted folders and settings. To apply a change to docker-compose.yml
        or .env, run docker compose up -d on the server instead.
      </p>
      {state === 'idle' && (
        <button type="button" className="modal-btn-primary" onClick={() => setState('confirm')}>Restart server</button>
      )}
      {state === 'confirm' && (
        <div className="modal-actions settings-server-confirm">
          <span>Restart now? Everyone is disconnected briefly.</span>
          <button type="button" className="modal-btn-primary" onClick={restart}>Restart now</button>
          <button type="button" className="modal-btn" onClick={() => setState('idle')}>Cancel</button>
        </div>
      )}
      {state === 'restarting' && (
        <p className="settings-server-text" role="status">Restarting… this page reloads when the server is back.</p>
      )}
      {state === 'failed' && (
        <>
          <div className="modal-error">{error}</div>
          <button type="button" className="modal-btn-primary" onClick={() => setState('idle')}>Back</button>
        </>
      )}
    </div>
  );
}
