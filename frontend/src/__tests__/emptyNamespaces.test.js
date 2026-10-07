import { describe, it, expect } from 'vitest';
import { emptyNamespacesMessage } from '../emptyNamespaces.js';

// GitHub issue #123: "No namespaces found. Check your mdnest.conf mounts." was
// shown for every cause, and a plain Docker Compose install has no mdnest.conf.
describe('empty namespaces message', () => {
  it('nothing mounted: points at the backend volumes, for compose and setup.sh alike', () => {
    const m = emptyNamespacesMessage('none-mounted');
    expect(m.title).toBe('No namespaces found');
    expect(m.detail).toContain('backend service (not the frontend)');
    expect(m.detail).toContain('./notes:/data/notes/notes');
    expect(m.detail).toContain('mdnest.conf');
  });
  it('files directly in /data/notes: mount one level down', () => {
    const m = emptyNamespacesMessage('files-at-root');
    expect(m.title).toMatch(/one level too high/);
    expect(m.detail).toContain('./notes:/data/notes/notes');
  });
  it('mounted but no access: not about mounts at all', () => {
    const user = emptyNamespacesMessage('no-access');
    expect(user.detail).toContain('Ask an admin');
    expect(user.detail).not.toMatch(/volume/i);
    const admin = emptyNamespacesMessage('no-access', { isAdmin: true });
    expect(admin.detail).toContain('Manage users & access');
    expect(admin.detail).toContain('grant yourself');
  });
  it('unreadable: permissions or SELinux, not mounts', () => {
    const m = emptyNamespacesMessage('unreadable');
    expect(m.title).toMatch(/cannot be read/);
    expect(m.detail).toContain(':z');
  });
  it('nothing mounted also covers a folder Docker cannot see', () => {
    expect(emptyNamespacesMessage('none-mounted').detail).toContain('File sharing');
  });
  it('an unknown or missing reason falls back to the mount advice', () => {
    expect(emptyNamespacesMessage('').title).toBe('No namespaces found');
    expect(emptyNamespacesMessage(undefined).title).toBe('No namespaces found');
  });
});
