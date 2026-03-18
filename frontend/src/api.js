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
  return res;
}

export async function login(username, password) {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error('Login failed');
  const data = await res.json();
  setToken(data.token);
  return data;
}

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
  return res.text();
}

export async function saveNote(ns, path, content) {
  const res = await request(`/note?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, {
    method: 'PUT',
    body: content,
  });
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

export { getToken, clearToken };
