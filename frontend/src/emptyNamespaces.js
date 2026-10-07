// What to say when there are no namespaces, by the server's reason
// (X-Namespaces-Empty-Reason, GitHub issue #123). One message used to cover
// every cause and pointed at mdnest.conf, which a plain Docker Compose install
// does not have, so someone with correct volumes was told to fix the wrong
// thing. Each message names the cause and the fix. Plain text: shown as-is.
export function emptyNamespacesMessage(reason, { isAdmin = false } = {}) {
  switch (reason) {
    case 'no-access':
      return {
        title: 'No namespaces you can open yet',
        detail: isAdmin
          ? 'Notes are mounted, but your account has no access to any namespace. Admins do not get access automatically: open Manage users & access and grant yourself (or a group you are in) access to a namespace.'
          : 'Notes are mounted, but your account has no access to any namespace yet. Ask an admin to grant you access.',
      };
    case 'files-at-root':
      return {
        title: 'Your notes are mounted one level too high',
        detail: 'The backend sees files directly in /data/notes, so they are not in any namespace. Mount the folder one level down, e.g. ./notes:/data/notes/notes, then restart the backend.',
      };
    case 'unreadable':
      return {
        title: 'The notes folder cannot be read',
        detail: 'The backend has a /data/notes it is not allowed to read. Check the folder permissions on the host, and on an SELinux host (Fedora, RHEL) add :z to the volume, e.g. ./notes:/data/notes/notes:z.',
      };
    case 'none-mounted':
    default:
      return {
        title: 'No namespaces found',
        detail: 'mdnest shows each folder mounted into the backend container at /data/notes/<name> as a namespace. Check the volumes are on the backend service (not the frontend), e.g. ./notes:/data/notes/notes, and restart it. If the folder exists but mdnest still sees nothing, Docker cannot see it: on Docker Desktop add it under Settings > Resources > File sharing. With setup.sh, add a MOUNT_<name>= line to mdnest.conf and run ./mdnest-server reload. The backend log lists what it found.',
      };
  }
}
