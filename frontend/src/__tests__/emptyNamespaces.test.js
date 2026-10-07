import { describe, it, expect } from 'vitest';
import { emptyNamespacesMessage, emptyNamespacesFix } from '../emptyNamespaces.js';

// GitHub issue #123: "No namespaces found. Check your mdnest.conf mounts." was
// shown for every cause, and a plain Docker Compose install has no mdnest.conf.
describe('empty namespaces message', () => {
  it('nothing mounted: points at the backend volumes', () => {
    const m = emptyNamespacesMessage('none-mounted');
    expect(m.title).toBe('No namespaces found');
    expect(m.detail).toContain('backend service (not the frontend)');
    expect(m.detail).toContain('/data/notes/<name>');
  });
  it('files directly in /data/notes: mount one level down', () => {
    const m = emptyNamespacesMessage('files-at-root');
    expect(m.title).toMatch(/one level too high/);
    expect(m.detail).toContain('one level down');
  });
  it('mounted but no access: not about mounts at all', () => {
    const user = emptyNamespacesMessage('no-access');
    expect(user.detail).toContain('Ask an admin');
    expect(user.detail).not.toMatch(/volume/i);
    const admin = emptyNamespacesMessage('no-access', { isAdmin: true });
    expect(admin.detail).toContain('Manage users & access');
    expect(admin.detail).toContain('Give yourself access');
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
  // A restart (docker compose restart, or Settings) keeps the old mounts, so
  // telling someone to "restart" after a mount change sends them in a circle.
  it('a mount fix says docker compose up -d, never restart', () => {
    for (const r of ['none-mounted', 'files-at-root', 'unreadable']) {
      const { detail } = emptyNamespacesMessage(r, { isAdmin: true });
      expect(detail).toContain('docker compose up -d');
      expect(detail).not.toMatch(/restart/i);
    }
  });
});

describe('empty namespaces fix', () => {
  it('no access: an admin in multi mode can grant themselves access', () => {
    expect(emptyNamespacesFix('no-access', { isAdmin: true, isMulti: true })).toEqual({ grantSelf: true });
    expect(emptyNamespacesFix('no-access', { isAdmin: false, isMulti: true })).toEqual({ grantSelf: false });
  });
  it('mount problems: the lines to paste, for compose and setup.sh', () => {
    const f = emptyNamespacesFix('none-mounted', { isAdmin: true });
    expect(f.compose).toContain('  backend:\n    volumes:\n      - ./notes:/data/notes/notes\n');
    expect(f.setupConf).toMatch(/^MOUNT_notes=/);
    expect(emptyNamespacesFix('files-at-root', { isAdmin: true }).compose).toContain('./notes:/data/notes/notes\n');
  });
  it('unreadable: the volume carries :z', () => {
    expect(emptyNamespacesFix('unreadable', { isAdmin: true }).compose).toContain('./notes:/data/notes/notes:z\n');
  });
  it('a collaborator is not shown a mount fix they cannot apply', () => {
    expect(emptyNamespacesFix('none-mounted', { isAdmin: false, isMulti: true })).toEqual({});
  });
});
