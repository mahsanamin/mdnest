const BASE = '/api';

function getToken() {
  return localStorage.getItem('mdnest_token');
}

function setToken(token) {
  localStorage.setItem('mdnest_token', token);
}

function clearToken() {
  localStorage.removeItem('mdnest_token');
}

class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
  }
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = { ...options.headers };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE}${path}`, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('Unauthorized');
  }
  if (res.status === 403) {
    const data = await res.json().catch(() => ({}));
    throw new PermissionError(data.error || 'Access denied');
  }
  return res;
}

// --- Public (no auth) ---

export async function fetchConfig() {
  const res = await fetch(`${BASE}/config`);
  if (!res.ok) return { authMode: 'single' };
  return res.json();
}

// --- Auth ---

export async function login(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Login failed');
  }
  const data = await res.json();
  // Multi-step login: may return status instead of token
  if (data.token) setToken(data.token);
  return data;
}

export async function verifyTOTP(tempToken, code) {
  const res = await fetch(`${BASE}/auth/verify-totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken, code }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Verification failed');
  }
  const data = await res.json();
  if (data.token) setToken(data.token);
  return data;
}

export async function setupTOTPWithTemp(tempToken, code) {
  const res = await fetch(`${BASE}/auth/totp/setup-with-temp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken, code: code || '' }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Setup failed');
  }
  const data = await res.json();
  if (data.token) setToken(data.token);
  return data;
}

export async function forcedPasswordChange(tempToken, newPassword) {
  const res = await fetch(`${BASE}/auth/change-password-forced`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken, newPassword }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Password change failed');
  }
  const data = await res.json();
  if (data.token) setToken(data.token);
  return data;
}

export function logout() {
  clearToken();
  window.location.reload();
}

export async function changePassword(currentPassword, newUsername, newPassword) {
  const res = await request('/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newUsername, newPassword }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to change password');
  }
  return res.json();
}

export async function listTokens() {
  const res = await request('/auth/tokens');
  if (!res.ok) throw new Error('Failed to list tokens');
  return res.json();
}

export async function createToken(name) {
  const res = await request('/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error('Failed to create token');
  return res.json();
}

export async function revokeToken(id) {
  const res = await request(`/auth/tokens?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to revoke token');
  return res.json();
}

// --- User info (multi mode) ---

export async function fetchMe() {
  const res = await request('/me');
  if (!res.ok) return null;
  return res.json();
}

// --- Namespaces & Files ---

export async function getNamespaces() {
  const res = await request('/namespaces');
  if (!res.ok) throw new Error('Failed to load namespaces');
  return res.json();
}

export async function getTree(ns) {
  const res = await request(`/tree?ns=${encodeURIComponent(ns)}`);
  if (!res.ok) throw new Error('Failed to load tree');
  return res.json();
}

export async function getNote(ns, path) {
  const res = await request(`/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error('Failed to get note');
  const text = await res.text();
  const etag = res.headers.get('ETag');
  const noteId = res.headers.get('X-Note-ID');
  return { text, etag, noteId };
}

export async function saveNote(ns, path, content, ifMatch) {
  const headers = {};
  if (ifMatch) headers['If-Match'] = ifMatch;
  const res = await request(`/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    headers,
    body: content,
  });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || 'File was modified');
    err.status = 409;
    err.etag = data.etag;
    throw err;
  }
  if (!res.ok) throw new Error('Failed to save note');
  return res.json();
}

export async function createNote(ns, path) {
  const res = await request(`/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, {
    method: 'POST',
    body: '',
  });
  if (!res.ok) throw new Error('Failed to create note');
  return res.json();
}

export async function deleteNote(ns, path) {
  const res = await request(`/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete note');
  return res.json();
}

export async function createFolder(ns, path) {
  const res = await request(`/folder?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to create folder');
  return res.json();
}

export async function uploadImage(ns, notePath, file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await request(`/upload?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(notePath)}`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error('Failed to upload image');
  return res.json();
}

export async function searchNotes(ns, query) {
  const res = await request(`/search?ns=${encodeURIComponent(ns)}&q=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error('Failed to search');
  return res.json();
}

export async function moveItem(ns, fromPath, toPath) {
  const res = await request(`/move?ns=${encodeURIComponent(ns)}&from=${encodeURIComponent(fromPath)}&to=${encodeURIComponent(toPath)}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to move item');
  return res.json();
}

// --- Admin (multi mode) ---

export async function adminListUsers() {
  const res = await request('/admin/users');
  if (!res.ok) throw new Error('Failed to list users');
  return res.json();
}

export async function adminInviteUser(email, username, password, role) {
  const res = await request('/admin/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password, role }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to invite user');
  }
  return res.json();
}

export async function adminDeleteUser(id) {
  const res = await request(`/admin/users?id=${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete user');
  }
  return res.json();
}

export async function adminUpdateRole(id, role) {
  const res = await request(`/admin/users?id=${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update role');
  }
  return res.json();
}

export async function adminListGrants(params) {
  const qs = new URLSearchParams(params).toString();
  const res = await request(`/admin/grants?${qs}`);
  if (!res.ok) throw new Error('Failed to list grants');
  return res.json();
}

export async function adminCreateGrant(userId, namespace, path, permission) {
  const res = await request('/admin/grants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, namespace, path, permission }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create grant');
  }
  return res.json();
}

export async function adminUpdateGrant(id, permission) {
  const res = await request(`/admin/grants?id=${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permission }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update grant');
  }
  return res.json();
}

export async function adminDeleteGrant(id) {
  const res = await request(`/admin/grants?id=${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete grant');
  return res.json();
}

export async function adminSyncStatus(ns) {
  const res = await request(`/admin/sync-status?ns=${encodeURIComponent(ns)}`);
  if (!res.ok) return null;
  return res.json();
}

export async function adminSyncNamespace(ns) {
  const res = await request(`/admin/sync?ns=${encodeURIComponent(ns)}`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || data.error || 'Sync failed');
  }
  return res.json();
}

// --- Comments ---

export async function listComments(ns, path) {
  const res = await request(`/comments?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`);
  if (!res.ok) return [];
  return res.json();
}

export async function createComment(ns, path, { rangeStart, rangeEnd, anchorText, body, parentId }) {
  const res = await request(`/comments?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rangeStart, rangeEnd, anchorText, body, parentId: parentId || '' }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create comment');
  }
  return res.json();
}

export async function resolveComment(ns, path, commentId, resolved) {
  const res = await request(`/comments?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}&id=${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolved }),
  });
  if (!res.ok) throw new Error('Failed to update comment');
  return res.json();
}

export async function deleteComment(ns, path, commentId) {
  const res = await request(`/comments?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}&id=${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete comment');
  return res.json();
}

export { getToken, clearToken, PermissionError };
