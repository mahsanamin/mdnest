// What to say when there are no namespaces, by the server's reason
// (X-Namespaces-Empty-Reason, GitHub issue #123). One message used to cover
// every cause and pointed at mdnest.conf, which a plain Docker Compose install
// does not have, so someone with correct volumes was told to fix the wrong
// thing. Each message names the cause and the fix. Plain text: shown as-is.
//
// Mount changes only take effect when the container is re-created
// (`docker compose up -d`); `docker compose restart` and the Settings restart
// keep the old mounts, so the messages never say "restart" for a mount fix.
export function emptyNamespacesMessage(reason, { isAdmin = false } = {}) {
  switch (reason) {
    case 'no-access':
      return {
        title: 'No namespaces you can open yet',
        detail: isAdmin
          ? 'Notes are mounted, but your account has no access to any namespace. Admins do not get access automatically. Give yourself access below, or choose namespaces in Manage users & access.'
          : 'Notes are mounted, but your account has no access to any namespace yet. Ask an admin to grant you access.',
      };
    case 'files-at-root':
      return {
        title: 'Your notes are mounted one level too high',
        detail: 'The backend sees files directly in /data/notes, so they are not in any namespace. Mount the folder one level down, as below, then run docker compose up -d on the server.',
      };
    case 'unreadable':
      return {
        title: 'The notes folder cannot be read',
        detail: 'The backend has a /data/notes it is not allowed to read. Check the folder permissions on the host. On an SELinux host (Fedora, RHEL), add :z to the volume as below, then run docker compose up -d.',
      };
    case 'none-mounted':
    default:
      return {
        title: 'No namespaces found',
        detail: 'mdnest shows each folder mounted into the backend container at /data/notes/<name> as a namespace. Put the volume on the backend service (not the frontend), as below, then run docker compose up -d on the server. If the folder exists but mdnest still sees nothing, Docker cannot see it: on Docker Desktop add it under Settings > Resources > File sharing. The backend log lists what it found.',
      };
  }
}

// What the empty page can offer to fix it, by reason:
//   grantSelf  an admin can give themselves access here (multi mode only)
//   compose    lines for the backend service in docker-compose.yml
//   setupConf  the same fix for a setup.sh install (mdnest.conf)
// A collaborator gets nothing to act on beyond asking an admin, and nobody is
// shown a mount fix they could not apply: mounts are the server owner's.
export function emptyNamespacesFix(reason, { isAdmin = false, isMulti = false } = {}) {
  if (reason === 'no-access') {
    return { grantSelf: isAdmin && isMulti };
  }
  if (!isAdmin) return {};
  const suffix = reason === 'unreadable' ? ':z' : '';
  return {
    compose:
      'services:\n' +
      '  backend:\n' +
      '    volumes:\n' +
      `      - ./notes:/data/notes/notes${suffix}\n`,
    setupConf: 'MOUNT_notes=/path/to/your/notes',
  };
}
