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

// Accepts either (username, password) — classic local-mode form — or a
// single object body like { idToken } for Firebase sign-in. The backend
// picks the right branch based on which fields are present.
// `rememberMe`, when true, asks the backend to issue a 1-year JWT instead
// of the default 30 days — keeps the user logged in across browser
// restarts for a year. Passed through every step of the login flow
// (initial login + TOTP verify + forced password change) so the final
// token gets the right TTL regardless of which path the user took.
export async function login(a, b, rememberMe) {
  const body = typeof a === 'object' && a !== null
    ? { ...a, rememberMe: a.rememberMe ?? rememberMe }
    : { username: a, password: b, rememberMe };
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

export async function verifyTOTP(tempToken, code, rememberMe) {
  const res = await fetch(`${BASE}/auth/verify-totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken, code, rememberMe }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Verification failed');
  }
  const data = await res.json();
  if (data.token) setToken(data.token);
  return data;
}

export async function setupTOTPWithTemp(tempToken, code, rememberMe) {
  const res = await fetch(`${BASE}/auth/totp/setup-with-temp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken, code: code || '', rememberMe }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Setup failed');
  }
  const data = await res.json();
  if (data.token) setToken(data.token);
  return data;
}

export async function forcedPasswordChange(tempToken, newPassword, rememberMe) {
  const res = await fetch(`${BASE}/auth/change-password-forced`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tempToken, newPassword, rememberMe }),
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

// getManageableNamespaces returns the namespaces the caller may administer
// (every namespace for a superadmin, the caller's scoped namespaces for a
// namespace admin). Unlike getNamespaces() this is not limited to the
// namespaces the caller can access, so a superadmin — who has no implicit data
// access — can still manage every namespace from the admin panel.
export async function getManageableNamespaces() {
  const res = await request('/namespaces?scope=manage');
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

export async function saveNote(ns, path, content, ifMatch, opts = {}) {
  const headers = {};
  if (ifMatch) headers['If-Match'] = ifMatch;
  let url = `/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`;
  if (opts.allowEmpty) url += '&allow-empty=1';
  if (opts.restoreFrom) url += `&restore-from=${encodeURIComponent(opts.restoreFrom)}`;
  const res = await request(url, {
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

// Explicit "make this file empty" action. Bypasses the backend's refuse-to-
// truncate-to-empty guard via ?allow-empty=1. Use this for deliberate clear
// operations (e.g. a context-menu "Clear note" item); never for autosave.
export async function clearNote(ns, path, ifMatch) {
  return saveNote(ns, path, '', ifMatch, { allowEmpty: true });
}

// --- Note version history (v3.7.0+, requires git-sync sidecar) ---

// Fetch the per-file commit history. Returns an array of
// { commit, unix_ts, author, message } sorted newest-first, capped at 50.
// Returns null when git-sync isn't configured for this namespace (404)
// so callers can hide the History UI gracefully.
export async function getNoteHistory(ns, path) {
  const res = await request(`/note/history?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Failed to load history');
  return res.json();
}

// Fetch a file's content at a specific commit SHA.
// ref must be a hex string (commit SHA); branch names are rejected by
// the backend.
export async function getNoteAtCommit(ns, path, ref) {
  const res = await request(`/note/at?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to load historical version');
  }
  return res.text();
}

// Restore a file to a previous version. Goes through the regular saveNote
// path (so the empty-overwrite guard, ETag conflict detection, and
// websocket file-changed broadcast all run as usual), with restore-from
// tagging the broadcast so other connected users see a distinct
// "X restored this file" banner instead of the conflict banner.
export async function restoreNote(ns, path, ref, content, ifMatch) {
  return saveNote(ns, path, content, ifMatch, { restoreFrom: ref });
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

// --- Tasks & kanban board (namespace-scoped) ---

// Aggregate every markdown task-list item in the namespace plus the board
// column layout. Returns { board: {version, columns}, tasks: [...] }.
export async function getTasks(ns, path) {
  const q = path ? `&path=${encodeURIComponent(path)}` : '';
  const res = await request(`/tasks?ns=${encodeURIComponent(ns)}${q}`);
  if (!res.ok) throw new Error('Failed to load tasks');
  return res.json();
}

// Aggregate tasks across every workspace the caller can access (the global
// view). Each task carries its owning `namespace`; the board is the union of
// the per-workspace column layouts.
export async function getAllTasks() {
  const res = await request('/tasks/all');
  if (!res.ok) throw new Error('Failed to load tasks');
  return res.json();
}

// Create a task by appending it to a note. `body` is { text, note?, column? };
// when note is omitted the board's default note is used.
export async function createTask(ns, body) {
  const res = await request(`/tasks?ns=${encodeURIComponent(ns)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create task');
  }
  return res.json();
}

// Move a task to a column or toggle its checkbox. `mutation` is
// { line, raw, toColumn } or { line, raw, checked }. `path` is the note that
// owns the task. Throws a 409-tagged error when the source line has shifted.
export async function patchTask(ns, path, mutation) {
  const res = await request(`/tasks?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mutation),
  });
  if (res.status === 409) {
    const err = new Error('Task is out of date; refresh the board');
    err.status = 409;
    throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to update task');
  }
  return res.json();
}

export async function getBoard(ns) {
  const res = await request(`/board?ns=${encodeURIComponent(ns)}`);
  if (!res.ok) throw new Error('Failed to load board');
  return res.json();
}

// List the users who have access to a namespace, to populate the task
// assignee picker. Returns [{ id, username }]. Returns [] when the endpoint
// isn't available (single mode / task board off), so callers degrade to a
// free-choice list built from the current user and any existing assignee.
export async function getNamespaceUsers(ns) {
  const res = await request(`/namespace/users?ns=${encodeURIComponent(ns)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('Failed to load namespace users');
  return res.json();
}

export async function saveBoard(ns, board) {
  const res = await request(`/board?ns=${encodeURIComponent(ns)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(board),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to save board');
  }
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

export async function adminInviteUser(email, username, password, role, namespace) {
  const res = await request('/admin/invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, username, password, role, namespace }),
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

export async function adminResetPassword(userId, newPassword) {
  const res = await request('/admin/reset-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, new_password: newPassword }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to reset password');
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

// --- Namespace admin assignments (v3.5.0+) ---

export async function adminListNamespaceAdmins(ns) {
  const res = await request(`/admin/namespace-admins?ns=${encodeURIComponent(ns)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to list namespace admins');
  }
  return res.json();
}

export async function adminAddNamespaceAdmin(userId, namespace) {
  const res = await request('/admin/namespace-admins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, namespace }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to add namespace admin');
  }
  return res.json();
}

export async function adminRemoveNamespaceAdmin(userId, ns) {
  const res = await request(`/admin/namespace-admins?user_id=${userId}&ns=${encodeURIComponent(ns)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to remove namespace admin');
  }
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

// --- Per-workspace git remotes (multi mode, opt-in) ---
// The stored credential (PAT / SSH key) is never returned by the server; these
// responses only report has_credential.

export async function adminListWorkspaces() {
  const res = await request('/admin/workspaces');
  if (!res.ok) throw new Error('Failed to list workspaces');
  return res.json();
}

export async function adminSaveWorkspace(payload, id) {
  const res = await request(id ? `/admin/workspaces?id=${id}` : '/admin/workspaces', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to save workspace');
  }
  return res.json();
}

export async function adminDeleteWorkspace(id) {
  const res = await request(`/admin/workspaces?id=${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete workspace');
  }
  return res.json();
}

// Workspace groups: a shared git remote base (one repo per namespace), the
// UI equivalent of the GIT_REMOTE_URL env provisioning.

export async function adminListWorkspaceGroups() {
  const res = await request('/admin/workspace-groups');
  if (!res.ok) throw new Error('Failed to list workspace groups');
  return res.json();
}

export async function adminSaveWorkspaceGroup(payload, id) {
  const res = await request(id ? `/admin/workspace-groups?id=${id}` : '/admin/workspace-groups', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to save workspace group');
  }
  return res.json();
}

export async function adminDeleteWorkspaceGroup(id) {
  const res = await request(`/admin/workspace-groups?id=${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete workspace group');
  }
  return res.json();
}

// Create a workspace inside a group: only the namespace is needed; it inherits
// the group's remote base + credential.
export async function adminCreateWorkspaceInGroup(namespace, groupId) {
  const res = await request('/admin/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ namespace, group_id: groupId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to create workspace in group');
  }
  return res.json();
}

export async function getMyWorkspace() {
  const res = await request('/me/workspace');
  if (!res.ok) throw new Error('Failed to load personal workspace');
  return res.json();
}

export async function saveMyWorkspace(payload) {
  const res = await request('/me/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to save workspace');
  }
  return res.json();
}

export async function deleteMyWorkspace() {
  const res = await request('/me/workspace', { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to remove workspace');
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

export async function editComment(ns, path, commentId, body) {
  const res = await request(`/comments?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}&id=${encodeURIComponent(commentId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to edit comment');
  }
  return res.json();
}

export async function deleteComment(ns, path, commentId) {
  const res = await request(`/comments?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}&id=${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('Failed to delete comment');
  return res.json();
}

// --- Marp themes (centralized presentation catalog) ---

// getMarpThemes returns the shared Marp theme catalog: [{name, css}]. Readable
// by any authenticated user; used by MarpDeck to register themes globally.
export async function getMarpThemes() {
  const res = await request('/marp/themes');
  if (!res.ok) return [];
  return res.json();
}

export async function saveMarpTheme(name, css) {
  const res = await request('/marp/themes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, css }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to save theme');
  }
  return res.json();
}

export async function deleteMarpTheme(name) {
  const res = await request(`/marp/themes?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete theme');
  return res.json();
}

export { getToken, setToken, clearToken, PermissionError };
