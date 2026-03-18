import { useState, useEffect, useCallback } from 'react';
import { changePassword, listTokens, createToken, revokeToken } from '../api.js';

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
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>MCP</button>
          <button className={tab === 'api' ? 'active' : ''} onClick={() => setTab('api')}>API</button>
          <button className={tab === 'password' ? 'active' : ''} onClick={() => setTab('password')}>Credentials</button>
        </div>
        {tab === 'tokens' && <TokensTab />}
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
      navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="settings-content">
      <p className="settings-description">
        Create tokens for MCP servers and API clients. Tokens don't expire -- revoke them when no longer needed.
      </p>

      {newToken && (
        <div className="token-created">
          <div className="token-created-label">Token created -- copy it now, it won't be shown again:</div>
          <div className="token-created-value">
            <code>{newToken}</code>
            <button onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <button className="modal-btn" onClick={() => setNewToken(null)} style={{ marginTop: '0.5rem' }}>Dismiss</button>
        </div>
      )}

      <div className="token-create-row">
        <input
          type="text"
          className="modal-input"
          placeholder="Token name (e.g. Claude MCP, backup script)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
        />
        <button className="modal-btn-primary" onClick={handleCreate}>Create</button>
      </div>

      {loading ? (
        <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>Loading...</p>
      ) : tokens.length === 0 ? (
        <p style={{ color: '#6c7086', fontSize: '0.85rem' }}>No tokens yet. Create one to connect MCP or API clients.</p>
      ) : (
        <div className="token-list">
          {tokens.map((t) => (
            <div key={t.id} className="token-item">
              <div className="token-info">
                <span className="token-name">{t.name}</span>
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

function McpTab() {
  return (
    <div className="settings-content">
      <h4 className="settings-section-title">MCP Server</h4>
      <p className="settings-description">
        The MCP server lets AI assistants (Claude, Cursor, etc.) read, write, search, and organize your notes directly.
      </p>

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
        "MDNEST_URL": "http://localhost:8286",
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
  return (
    <div className="settings-content">
      <h4 className="settings-section-title">REST API</h4>
      <p className="settings-description">
        All endpoints accept a Bearer token in the Authorization header. Create a token in the API Tokens tab.
      </p>

      <h4 className="settings-section-title">Authentication</h4>
      <div className="settings-code">
        <pre>{`# Use your API token
curl -H "Authorization: Bearer mdnest_your_token_here" \\
  http://localhost:8286/api/namespaces`}</pre>
      </div>

      <h4 className="settings-section-title">Examples</h4>

      <div className="settings-code">
        <div className="code-label">List namespaces</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  http://localhost:8286/api/namespaces`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Get file tree</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  "http://localhost:8286/api/tree?ns=my_notes"`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Read a note</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  "http://localhost:8286/api/note?ns=my_notes&path=ideas/project.md"`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Create a note</div>
        <pre>{`curl -X POST -H "Authorization: Bearer $TOKEN" \\
  -d "# New Note" \\
  "http://localhost:8286/api/note?ns=my_notes&path=new-note.md"`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Update a note</div>
        <pre>{`curl -X PUT -H "Authorization: Bearer $TOKEN" \\
  -d "# Updated content" \\
  "http://localhost:8286/api/note?ns=my_notes&path=new-note.md"`}</pre>
      </div>

      <div className="settings-code">
        <div className="code-label">Search</div>
        <pre>{`curl -H "Authorization: Bearer $TOKEN" \\
  "http://localhost:8286/api/search?ns=my_notes&q=kubernetes"`}</pre>
      </div>

      <p className="settings-description" style={{ marginTop: '1rem' }}>
        See <a href="docs/api.md" target="_blank" style={{ color: '#89b4fa' }}>docs/api.md</a> for the full API reference.
      </p>
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
