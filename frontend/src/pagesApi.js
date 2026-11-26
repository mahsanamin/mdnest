// HTML page API calls (server: ENABLE_PAGES). Imported only by the lazy pages
// chunks (components/Pages.jsx, pagesDrop.js), never by the main bundle, so an
// install with pages off downloads none of this. Calls go through api.js's
// request(), with its JWT and 401 handling.
import { request, getToken, clearToken } from './api.js';

const BASE = '/api';

// The page handles in a namespace the caller can read, and, for writers of
// the namespace root, the stored pages no handle names (unlinked):
// { pages: [{ path, id, title, author, publishedAt, files, bytes, missing }], unlinked?: [...] }.
export async function listPages(ns, query) {
  const q = query ? `&q=${encodeURIComponent(query)}` : '';
  const res = await request(`/pages?ns=${encodeURIComponent(ns)}${q}`);
  if (!res.ok) throw new Error('Failed to load pages');
  return res.json();
}

// Namespace backups need write access to the whole namespace.
export async function exportPages(ns) {
  const res = await request(`/pages/export?ns=${encodeURIComponent(ns)}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Could not download pages');
  }
  return {
    blob: await res.blob(),
    exported: Number(res.headers.get('X-Mdnest-Pages-Exported') || 0),
    skipped: Number(res.headers.get('X-Mdnest-Pages-Skipped') || 0),
  };
}

export async function importPages(ns, file) {
  const res = await request(`/pages/import?ns=${encodeURIComponent(ns)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not restore pages');
  return data;
}

// A frame URL for the page a handle (<name>.page.md) names:
// { url, scripts, expiresAt, title, author, publishedAt }. Asked for again
// each time a page is opened, since the pass in it expires.
export async function getPagePass(ns, path) {
  const res = await request(`/pages/pass?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to open the page');
  }
  return res.json();
}

// Remove a stored page that no handle names any more.
export async function deleteUnlinkedPage(ns, id) {
  const res = await request(`/pages/unlinked?ns=${encodeURIComponent(ns)}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to delete the page');
  }
}

// Publish a page at a handle path. body is a Blob: one HTML file
// (text/html) or a tar of the page's folder (application/x-tar).
// onProgress(fraction) is called while the body uploads. XHR, not fetch,
// because fetch reports no upload progress.
export function publishPage(ns, path, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${BASE}/pages?ns=${encodeURIComponent(ns)}&path=${encodeURIComponent(path)}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', contentType);
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status === 401) {
        clearToken();
        window.location.reload();
        reject(new Error('Unauthorized'));
      } else if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        const err = new Error(data.error || `Publishing failed (${xhr.status})`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('Publishing failed: the server could not be reached'));
    xhr.send(body);
  });
}

