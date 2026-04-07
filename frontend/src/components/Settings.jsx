import { useState, useEffect, useCallback } from 'react';
import { changePassword, listTokens, createToken, revokeToken } from '../api.js';

// Derive server URL from current browser location
function getServerUrl() {
  return window.location.origin;
}

function Settings({ onClose }) {
  const [tab, setTab] = useState('tokens');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h3>Settings</h3>
          <button className="modal-close-btn" onClick={onClose}>x</button>
        </div>
        <div className="settings-tabs">
          <button className={tab === 'tokens' ? 'active' : ''} onClick={() => setTab('tokens')}>API Tokens</button>
          <button className={tab === 'cli' ? 'active' : ''} onClick={() => setTab('cli')}>CLI</button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>MCP</button>
          <button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>API</button>
          <button className={tab === 'password' ? 'active' : ''} onClick={() => setTab('password')}>Credentials</button>
        </div>
        {tab === 'tokens' && <TokensTab />}
        {tab === 'cli' && <CliTab />}
        {tab === 'mcp' && <McpTab />}
        {tab === 'api' && <ApiTab />}
        {tab === 'password' && <PasswordTab />}
      </div>
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
        <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>Loading...</p>
      ) : tokens.length === 0 ? (
        <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>No tokens yet. Create one to connect CLI, MCP, or API clients.</p>
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

function CliTab() {
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
          <span>Install the CLI (one command):</span>
        </div>
      </div>
      <div className="settings-code">
        <pre>curl -fsSL https://raw.githubusercontent.com/mahsanamin/mdnest/main/install-cli.sh | bash</pre>
      </div>

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">2</span>
          <span>Create an API token in the <strong>API Tokens</strong> tab, then login:</span>
        </div>
      </div>
      <div className="settings-code">
        <pre>{`mdnest login ${serverUrl} <your-token>`}</pre>
      </div>

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">3</span>
          <span>Start using it:</span>
        </div>
      </div>
      <div className="settings-code">
        <pre>{`mdnest list                              # list namespaces
mdnest list <namespace>                  # list files
mdnest read <namespace>/path/to/note.md  # read a note
mdnest search <namespace> "query"        # search
mdnest write <namespace>/path.md "text"  # write
echo "text" | mdnest append <namespace>/log.md -  # pipe`}</pre>
      </div>

      <h4 className="settings-section-title">Multi-Server</h4>
      <p className="settings-description">
        Manage multiple mdnest servers with @alias paths:
      </p>
      <div className="settings-code">
        <pre>{`mdnest login @work ${serverUrl} <token>
mdnest login @personal https://home:3236 <token>
mdnest read @work/<namespace>/path.md
mdnest servers                           # list all servers`}</pre>
      </div>
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
      <div className="settings-code">
        <pre>cd mcp-server && npm install</pre>
      </div>

      <div className="settings-steps">
        <div className="settings-step">
          <span className="step-num">3</span>
          <span>Add to your MCP client config (e.g. Claude Desktop):</span>
        </div>
      </div>
      <div className="settings-code">
        <pre>{`{
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
}`}</pre>
      </div>

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
      <div className="settings-code">
        <pre>{`# Use your API token
curl -H "Authorization: Bearer mdnest_your_token_here" \\
  ${serverUrl}/api/namespaces`}</pre>
      </div>

      <h4 className="settings-section-title">Examples</h4>

      <div className="settings-code">
        <div className="code-label">List namespaces</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  ${serverUrl}/api/namespaces`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Get file tree</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  "${serverUrl}/api/tree?ns=my_notes"`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Read a note</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  "${serverUrl}/api/note?ns=my_notes&path=ideas/project.md"`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Create a note</div>
        <pre>{`curl -X POST -H "Authorization: Bearer $TOKEN" \\
  -d "# New Note" \\
  "${serverUrl}/api/note?ns=my_notes&path=new-note.md"`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Search</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  "${serverUrl}/api/search?ns=my_notes&q=kubernetes"`}</pre>
      </div>
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
        <p style={{ color: '#a6e3a1', margin: '1rem 0' }}>
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
      <form onSubmit={handleSubmit}>
        {error && <div className="modal-error">{error}</div>}
        <label className="modal-label">Current Password</label>
        <input type="password" className="modal-input" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus />
        <label className="modal-label">New Username (leave blank to keep current)</label>
        <input type="text" className="modal-input" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} placeholder="Optional" />
        <label className="modal-label">New Password</label>
        <input type="password" className="modal-input" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
        <label className="modal-label">Confirm New Password</label>
        <input type="password" className="modal-input" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
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
