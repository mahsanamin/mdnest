import { useState } from 'react';
import { changePassword } from '../api.js';

function ChangePassword({ onClose }) {
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

    if (!currentPassword) {
      setError('Current password is required');
      return;
    }
    if (!newPassword) {
      setError('New password is required');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters');
      return;
    }

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
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>Credentials Updated</h3>
          <p style={{ color: '#a6e3a1', margin: '1rem 0' }}>
            Password changed successfully. You will need to log in again with your new credentials.
          </p>
          <button
            className="modal-btn-primary"
            onClick={() => {
              localStorage.removeItem('mdnest_token');
              window.location.reload();
            }}
          >
            Log in again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Change Credentials</h3>
        <form onSubmit={handleSubmit}>
          {error && <div className="modal-error">{error}</div>}
          <label className="modal-label">Current Password</label>
          <input
            type="password"
            className="modal-input"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoFocus
          />
          <label className="modal-label">New Username (leave blank to keep current)</label>
          <input
            type="text"
            className="modal-input"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            placeholder="Optional"
          />
          <label className="modal-label">New Password</label>
          <input
            type="password"
            className="modal-input"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
          />
          <label className="modal-label">Confirm New Password</label>
          <input
            type="password"
            className="modal-input"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
          />
          <div className="modal-actions">
            <button type="button" className="modal-btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="modal-btn-primary" disabled={loading}>
              {loading ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default ChangePassword;
