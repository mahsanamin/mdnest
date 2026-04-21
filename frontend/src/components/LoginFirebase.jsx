import { useState, useRef, useEffect } from 'react';
import { login, verifyTOTP, setupTOTPWithTemp } from '../api.js';
import { signInWithGoogle } from '../firebase-config.js';

// Auto-focus helper — same pattern as Login.jsx
function useAutoFocus(deps) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.focus();
  }, deps);
  return ref;
}

// Login component used when the server runs USER_PROVIDER=firebase.
// Identity comes from Google OAuth (via Firebase Auth); authorization is
// still per-server — if your email isn't granted access on this server, the
// backend rejects with a clear "not authorized" message.
function LoginFirebase({ onLogin }) {
  const [step, setStep] = useState('sign_in'); // sign_in, totp, totp_setup
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tempToken, setTempToken] = useState('');

  const [totpCode, setTotpCode] = useState('');

  // TOTP setup (REQUIRE_2FA first-time) state
  const [qrCode, setQrCode] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [setupCode, setSetupCode] = useState('');
  const [codesShown, setCodesShown] = useState(false);

  const totpInputRef = useAutoFocus([step === 'totp']);
  const setupInputRef = useAutoFocus([step === 'totp_setup', codesShown]);

  const handleGoogleSignIn = async () => {
    setError('');
    setLoading(true);
    try {
      const { idToken } = await signInWithGoogle();
      const data = await login({ idToken });
      if (data.status === 'totp_required') {
        setTempToken(data.tempToken);
        setStep('totp');
      } else if (data.status === 'totp_setup_required') {
        setTempToken(data.tempToken);
        const setup = await setupTOTPWithTemp(data.tempToken);
        setQrCode(setup.qrCode);
        setTotpSecret(setup.secret);
        setRecoveryCodes(setup.recoveryCodes || []);
        setStep('totp_setup');
      } else if (data.token) {
        onLogin();
      }
    } catch (err) {
      // Firebase popup errors have a `.code` but we just show the message.
      setError(err?.message || 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTOTPVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await verifyTOTP(tempToken, totpCode);
      if (data.token) onLogin();
    } catch (err) {
      setError(err?.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  const handleTOTPSetupVerify = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await setupTOTPWithTemp(tempToken, setupCode);
      if (data.token) onLogin();
    } catch (err) {
      setError(err?.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  if (step === 'sign_in') {
    return (
      <div className="login-screen">
        <div className="login-box">
          <h1>mdnest</h1>
          <p className="login-subtitle">Sign in with your Google account.</p>
          {error && <div className="login-error">{error}</div>}
          <button type="button" className="google-signin-btn" onClick={handleGoogleSignIn} disabled={loading}>
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 8 }}>
              <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
              <path fill="#FF3D00" d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
              <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
              <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571.001-.001.002-.001.003-.002l6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
            </svg>
            {loading ? 'Signing in…' : 'Sign in with Google'}
          </button>
          <p className="login-hint" style={{ marginTop: 16 }}>
            You must be invited by an administrator before you can sign in.
          </p>
        </div>
      </div>
    );
  }

  if (step === 'totp') {
    return (
      <div className="login-screen">
        <form className="login-box" onSubmit={handleTOTPVerify}>
          <h1>mdnest</h1>
          <p className="login-subtitle">Enter the 6-digit code from your authenticator app.</p>
          {error && <div className="login-error">{error}</div>}
          <input
            ref={totpInputRef}
            type="text"
            placeholder="123456"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoComplete="one-time-code"
            inputMode="numeric"
            style={{ textAlign: 'center', fontSize: '1.5rem', letterSpacing: '0.3em' }}
          />
          <button type="submit" disabled={loading || totpCode.length < 6}>
            {loading ? 'Verifying...' : 'Verify'}
          </button>
          <p className="login-hint">You can also use a recovery code.</p>
        </form>
      </div>
    );
  }

  if (step === 'totp_setup') {
    return (
      <div className="login-screen">
        <div className="login-box totp-setup-box">
          <h1>mdnest</h1>
          <p className="login-subtitle">Your administrator requires two-factor authentication.</p>

          {!codesShown ? (
            <>
              <div className="totp-setup-steps">
                <div className="totp-step">
                  <span className="totp-step-num">1</span>
                  <span>Install an authenticator app (Google Authenticator, Authy, 1Password, etc.)</span>
                </div>
                <div className="totp-step">
                  <span className="totp-step-num">2</span>
                  <span>Scan this QR code with the app:</span>
                </div>
              </div>

              {qrCode && (
                <div className="totp-qr-container">
                  <img src={qrCode} alt="TOTP QR Code" className="totp-qr" />
                </div>
              )}

              <div className="totp-manual">
                <span>Or enter manually:</span>
                <code className="totp-secret">{totpSecret}</code>
              </div>

              <div className="totp-step">
                <span className="totp-step-num">3</span>
                <span>Enter the 6-digit code from your app:</span>
              </div>

              {error && <div className="login-error">{error}</div>}

              <form onSubmit={handleTOTPSetupVerify}>
                <input
                  ref={setupInputRef}
                  type="text"
                  placeholder="123456"
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  style={{ textAlign: 'center', fontSize: '1.5rem', letterSpacing: '0.3em' }}
                />
                <button type="submit" disabled={loading || setupCode.length < 6}>
                  {loading ? 'Verifying...' : 'Enable 2FA & Sign in'}
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="login-subtitle">Save these recovery codes somewhere safe. Each can be used once if you lose access to your authenticator app.</p>
              <div className="recovery-codes">
                {recoveryCodes.map((code, i) => (
                  <code key={i} className="recovery-code">{code}</code>
                ))}
              </div>
              <button onClick={() => onLogin()}>Continue to mdnest</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return null;
}

export default LoginFirebase;
