// Pure helpers for the task board's scope: which tasks a view counts, and how
// the Milestones view groups them when it spans every workspace.
//
// Scopes: 'global' (every workspace), 'workspace', 'folder' (a folder of the
// workspace and everything under it) and 'note'. Folder scope is cut from the
// workspace's tasks on the client: the server already drops every task the
// caller cannot read, so a folder view never shows more than the workspace one.

// effectiveScope falls back to the whole workspace when the scope needs
// something that is not there (no note open, no folder picked).
export function effectiveScope(scope, { currentPath, folder } = {}) {
  if (scope === 'note' && !currentPath) return 'workspace';
  if (scope === 'folder' && !folder) return 'workspace';
  if (['global', 'workspace', 'folder', 'note'].includes(scope)) return scope;
  return 'workspace';
}

// inFolder: the note at `path` is in `folder` or below it. '' is the root.
export function inFolder(path, folder) {
  const f = (folder || '').replace(/^\/+|\/+$/g, '');
  if (!f) return true;
  return path === f || path.startsWith(`${f}/`);
}

// scopeTasks keeps the tasks a folder scope shows; other scopes are loaded
// already cut to size by the server.
export function scopeTasks(tasks, scope, folder) {
  if (scope !== 'folder') return tasks;
  return tasks.filter((t) => inFolder(t.path, folder));
}

// milestonesInScope: on a folder or note scope, only the milestones that have
// tasks there; the whole workspace shows every milestone, empty ones included.
export function milestonesInScope(milestones, tasks, scope) {
  if (scope !== 'folder' && scope !== 'note') return milestones;
  const used = new Set(tasks.map((t) => t.milestone).filter(Boolean));
  return milestones.filter((m) => used.has(m.id));
}

// workspaceGroups splits the all-workspaces load into one group per workspace
// that has milestones: its own milestones, columns and tasks. `boards` maps a
// workspace to its board (the response's `boards`).
export function workspaceGroups(boards, tasks) {
  const byNs = new Map();
  for (const t of tasks) {
    const ns = t.namespace || '';
    if (!byNs.has(ns)) byNs.set(ns, []);
    byNs.get(ns).push(t);
  }
  return Object.entries(boards || {})
    .filter(([, b]) => (b?.milestones || []).length > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ns, b]) => ({
      ns,
      milestones: b.milestones,
      columns: b.columns || [],
      doneColumns: (b.columns || []).filter((c) => c.done || c.id === 'done').map((c) => c.id),
      tasks: byNs.get(ns) || [],
    }));
}

// sameTask: the task a detail panel follows, found again after a reload. A
// save rewrites the task's lines but never moves its first line.
export function sameTask(a, b) {
  return !!a && !!b && (a.namespace || '') === (b.namespace || '') && a.path === b.path && a.line === b.line;
}
