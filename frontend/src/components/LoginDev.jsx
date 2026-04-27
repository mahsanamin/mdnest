import { useState } from 'react';
import { setToken } from '../api.js';

// LoginDev — the email-only impersonation form behind /?login=dev.
//
// Only routed to when (1) appConfig.devLoginEnabled is true (the
// backend is running with INSECURE_DEV_LOGIN=true) and (2) the user
// manually visits /?login=dev. The default sign-in page never links
// here, so a casual visitor never sees it. The whole feature is gated
// at build/deploy time by the env var; without it the route 404s and
// the frontend never renders this component.
export default function LoginDev({ onLogin }) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!email) return;
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `dev-login failed (${res.status})`);
      }
      setToken(data.token);
      // Strip the ?login=dev query so refresh doesn't bring us back here.
      window.history.replaceState(null, '', '/');
      if (onLogin) onLogin(); else window.location.reload();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-box">
        <h1>mdnest</h1>
        <div className="dev-login-warning">
          <strong>Dev login backdoor</strong>
          <div>
            This signs you in as any user by email — no OAuth. Available because the
            backend is running with <code>INSECURE_DEV_LOGIN=true</code>. Strictly for
            local development. The default sign-in page still requires SSO.
          </div>
        </div>
        <form onSubmit={submit}>
          {error && <div className="login-error">{error}</div>}
          <input
            type="email"
            placeholder="email of an existing user"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in (dev)'}
          </button>
        </form>
        <div className="login-hint">
          <a href="/">← back to normal sign-in</a>
        </div>
      </div>
    </div>
  );
}
