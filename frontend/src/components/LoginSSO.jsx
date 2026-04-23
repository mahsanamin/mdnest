import { useMemo } from 'react';

// Sign-in button shown when the server runs USER_PROVIDER=sso.
// Everything interesting happens server-side:
//   1. Browser hits /api/auth/sso/start → 302 to IdP.
//   2. IdP bounces back to /api/auth/sso/callback → 302 here with
//      #sso_token=<jwt> (or #sso_error=<code>) in the URL fragment.
//   3. App.jsx's bootstrap reads the fragment, stashes the token in
//      localStorage under mdnest_token, and reloads without the hash.
function LoginSSO({ providerLabel, errorCode }) {
  const fromPath = useMemo(() => {
    // Preserve the current hash so the user lands back where they wanted.
    const { pathname, search, hash } = window.location;
    const p = (pathname || '/') + (search || '') + (hash || '');
    return p;
  }, []);

  const handleSignIn = () => {
    const url = `/api/auth/sso/start?from=${encodeURIComponent(fromPath)}`;
    window.location.assign(url);
  };

  return (
    <div className="login-screen">
      <div className="login-box">
        <h1>mdnest</h1>
        <p className="login-subtitle">Sign in with your corporate account.</p>
        {errorCode && <div className="login-error">{ssoErrorMessage(errorCode)}</div>}
        <button type="button" className="google-signin-btn" onClick={handleSignIn}>
          Sign in with {providerLabel || 'SSO'}
        </button>
        <p className="login-hint" style={{ marginTop: 16 }}>
          An administrator must have invited your email before you can sign in.
        </p>
      </div>
    </div>
  );
}

// Map the error code the backend redirected with to a readable message.
function ssoErrorMessage(code) {
  if (!code) return '';
  if (code.startsWith('sso_denied:')) return `The identity provider rejected the sign-in (${code.slice('sso_denied:'.length)}).`;
  switch (code) {
    case 'sso_failed':       return 'Sign-in failed. Please try again.';
    case 'sso_not_invited':  return "You're signed in with the identity provider, but no mdnest account matches your email. Ask an admin to invite you.";
    case 'sso_blocked':      return 'Your mdnest account is blocked. Contact your administrator.';
    case 'sso_internal':     return 'An internal error occurred. Please try again.';
    default:                 return `Sign-in error: ${code}`;
  }
}

export default LoginSSO;
