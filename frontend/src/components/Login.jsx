import { useState } from 'react';
import { login, verifyTOTP, setupTOTPWithTemp, forcedPasswordChange } from '../api.js';

function Login({ onLogin }) {
  const [step, setStep] = useState('login'); // login, change_password, totp, totp_setup
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tempToken, setTempToken] = useState('');

  // TOTP verify state
  const [totpCode, setTotpCode] = useState('');

  // TOTP setup state
  const [qrCode, setQrCode] = useState('');
  const [totpSecret, setTotpSecret] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [setupCode, setSetupCode] = useState('');
  const [codesShown, setCodesShown] = useState(false);

  // Forced password change state
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(username, password);
      if (data.status === 'change_password_required') {
        setTempToken(data.tempToken);
        setStep('change_password');
      } else if (data.status === 'totp_required') {
        setTempToken(data.tempToken);
        setStep('totp');
      } else if (data.status === 'totp_setup_required') {
        setTempToken(data.tempToken);
        // Fetch QR code
        const setup = await setupTOTPWithTemp(data.tempToken);
        setQrCode(setup.qrCode);
        setTotpSecret(setup.secret);
        setRecoveryCodes(setup.recoveryCodes || []);
        setStep('totp_setup');
      } else if (data.token) {
        onLogin();
      }
    } catch (err) {
      setError(err.message || 'Invalid username or password');
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
      setError(err.message || 'Invalid code');
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
      setError(err.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    try {
      const data = await forcedPasswordChange(tempToken, newPassword);
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
      setError(err.message || 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  // --- Login form ---
  if (step === 'login') {
    return (
      <div className="login-screen">
        <form className="login-box" onSubmit={handleLogin}>
          <h1>mdnest</h1>
          {error && <div className="login-error">{error}</div>}
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    );
  }

  // --- Forced password change ---
  if (step === 'change_password') {
    return (
      <div className="login-screen">
        <form className="login-box" onSubmit={handlePasswordChange}>
          <h1>mdnest</h1>
          <p className="login-subtitle">You must change your password before continuing.</p>
          {error && <div className="login-error">{error}</div>}
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoFocus
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Updating...' : 'Set new password'}
          </button>
        </form>
      </div>
    );
  }

  // --- TOTP verification (already set up) ---
  if (step === 'totp') {
    return (
      <div className="login-screen">
        <form className="login-box" onSubmit={handleTOTPVerify}>
          <h1>mdnest</h1>
          <p className="login-subtitle">Enter the 6-digit code from your authenticator app.</p>
          {error && <div className="login-error">{error}</div>}
          <input
            type="text"
            placeholder="123456"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
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

  // --- TOTP setup (forced by admin) ---
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
                  type="text"
                  placeholder="123456"
                  value={setupCode}
                  onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
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

export default Login;
