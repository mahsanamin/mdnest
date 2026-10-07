// Pure helpers for the admin panel's People and Namespaces views. The server
// keeps access in four places: a user's own grants, groups (members plus the
// group's grants), namespace admins, and the role. The panel used to show each
// in its own tab, so answering "what can alex reach?" meant visiting three of
// them. buildDirectory joins them once, per person and per namespace.
//
// No React here, so it is unit-tested on its own.

const RANK = { read: 1, write: 2 };

// The stronger of two permissions ('write' beats 'read').
export function strongerPermission(a, b) {
  return (RANK[b] || 0) > (RANK[a] || 0) ? b : a;
}

export function pathLabel(path) {
  return !path || path === '/' ? 'everything' : path;
}

// One row per (namespace, path) a user can reach, with every reason they can
// reach it. via items: {kind:'direct'} | {kind:'group', name} | {kind:'admin'}.
function addAccess(map, namespace, path, permission, via) {
  const key = `${namespace}\u0000${path || '/'}`;
  const row = map.get(key) || { namespace, path: path || '/', permission: null, via: [] };
  row.permission = row.permission ? strongerPermission(row.permission, permission) : permission;
  row.via.push(via);
  map.set(key, row);
}

function sortAccess(rows) {
  return rows.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.path.localeCompare(b.path));
}

// users:        [{id, username, email, role}]
// grants:       [{id, user_id, namespace, path, permission}]       (direct)
// groups:       [{id, name, description}]
// groupMembers: {[groupId]: [{user_id?, username?, oidc_group?}]}
// groupGrants:  {[groupId]: [{id, namespace, path, permission}]}
// nsAdmins:     {[namespace]: [{user_id}]}
export function buildDirectory({ users = [], grants = [], groups = [], groupMembers = {}, groupGrants = {}, nsAdmins = {} }) {
  const groupsByUser = new Map();
  for (const g of groups) {
    for (const m of groupMembers[g.id] || []) {
      if (m.user_id == null) continue;
      if (!groupsByUser.has(m.user_id)) groupsByUser.set(m.user_id, []);
      groupsByUser.get(m.user_id).push(g);
    }
  }
  const adminOfByUser = new Map();
  for (const [ns, rows] of Object.entries(nsAdmins)) {
    for (const a of rows || []) {
      if (!adminOfByUser.has(a.user_id)) adminOfByUser.set(a.user_id, []);
      adminOfByUser.get(a.user_id).push(ns);
    }
  }

  const people = users.map((u) => {
    const direct = grants.filter((g) => g.user_id === u.id);
    const memberOf = groupsByUser.get(u.id) || [];
    const adminOf = (adminOfByUser.get(u.id) || []).slice().sort();
    const access = new Map();
    for (const g of direct) addAccess(access, g.namespace, g.path, g.permission, { kind: 'direct' });
    for (const grp of memberOf) {
      for (const g of groupGrants[grp.id] || []) addAccess(access, g.namespace, g.path, g.permission, { kind: 'group', name: grp.name });
    }
    // A namespace admin reaches the whole namespace they administer.
    for (const ns of adminOf) addAccess(access, ns, '/', 'write', { kind: 'admin' });
    return { user: u, direct, groups: memberOf, adminOf, access: sortAccess([...access.values()]) };
  });

  return { people, byNamespace: (ns) => namespaceAccess(people, groups, groupGrants, nsAdmins, ns) };
}

// Everyone who can reach one namespace, and every group with access to it.
function namespaceAccess(people, groups, groupGrants, nsAdmins, ns) {
  const admins = new Set((nsAdmins[ns] || []).map((a) => a.user_id));
  const members = [];
  for (const p of people) {
    const rows = p.access.filter((r) => r.namespace === ns);
    if (rows.length === 0 && !admins.has(p.user.id)) continue;
    members.push({ person: p, rows, isAdmin: admins.has(p.user.id) });
  }
  members.sort((a, b) => (b.isAdmin - a.isAdmin) || name(a.person.user).localeCompare(name(b.person.user)));
  const groupRows = [];
  for (const g of groups) {
    for (const gr of groupGrants[g.id] || []) if (gr.namespace === ns) groupRows.push({ group: g, grant: gr });
  }
  return { members, groups: groupRows };
}

export function name(u) {
  return u.username || u.email || `user #${u.id}`;
}

// How a person's access reads in one short line: "Direct", "qa-team",
// "Admin", "Direct, qa-team".
export function viaLabel(via) {
  const seen = [];
  for (const v of via) {
    const label = v.kind === 'direct' ? 'Direct' : v.kind === 'admin' ? 'Admin' : v.name;
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(', ');
}

// The one-line summary on a person's card.
export function accessSummary(person) {
  const spaces = new Set(person.access.map((r) => r.namespace)).size;
  const parts = [];
  if (person.groups.length) parts.push(`${person.groups.length} group${person.groups.length === 1 ? '' : 's'}`);
  if (spaces) parts.push(`${spaces} namespace${spaces === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

// Free-text filter over name, email and group names.
export function matchesPerson(person, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [person.user.username, person.user.email, ...person.groups.map((g) => g.name)].join(' ').toLowerCase();
  return hay.includes(q);
}
