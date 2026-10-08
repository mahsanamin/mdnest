import { describe, it, expect } from 'vitest';
import { buildDirectory, viaLabel, accessSummary, matchesPerson, strongerPermission, gitBackupFor } from '../adminDirectory.js';

const users = [
  { id: 1, username: 'ahsan', email: 'a@x', role: 'superadmin' },
  { id: 2, username: 'alex', email: 'alex@x', role: 'collaborator' },
  { id: 3, username: 'sam', email: 'sam@x', role: 'admin' },
  { id: 4, username: 'jo', email: 'jo@x', role: 'collaborator' },
];
const groups = [{ id: 10, name: 'qa-team' }, { id: 11, name: 'writers' }];
const input = {
  users,
  grants: [
    { id: 100, user_id: 2, namespace: 'demo', path: '/', permission: 'read' },
    { id: 101, user_id: 2, namespace: 'bigproject', path: '/specs', permission: 'write' },
  ],
  groups,
  groupMembers: {
    10: [{ user_id: 2, username: 'alex' }, { user_id: 4, username: 'jo' }, { oidc_group: 'abc' }],
    11: [],
  },
  groupGrants: {
    10: [{ id: 200, namespace: 'demo', path: '/', permission: 'write' }],
    11: [{ id: 201, namespace: 'team_space', path: '/', permission: 'read' }],
  },
  nsAdmins: { bigproject: [{ user_id: 3 }], demo: [] },
};

describe('admin directory', () => {
  const dir = buildDirectory(input);
  const person = (id) => dir.people.find((p) => p.user.id === id);

  it('joins a person\'s own grants, their groups and what they administer', () => {
    const alex = person(2);
    expect(alex.direct.map((g) => g.id)).toEqual([100, 101]);
    expect(alex.groups.map((g) => g.name)).toEqual(['qa-team']);
    expect(person(3).adminOf).toEqual(['bigproject']);
  });

  it('takes the stronger permission when a group and a direct grant overlap, and keeps both reasons', () => {
    const demo = person(2).access.find((r) => r.namespace === 'demo');
    expect(demo.permission).toBe('write');
    expect(viaLabel(demo.via)).toBe('Direct, qa-team');
  });

  it('a person only in a group reaches what the group reaches', () => {
    expect(person(4).direct).toEqual([]);
    expect(person(4).access).toEqual([{ namespace: 'demo', path: '/', permission: 'write', via: [{ kind: 'group', name: 'qa-team' }] }]);
    expect(accessSummary(person(4))).toBe('1 group · 1 namespace');
  });

  it('an admin reaches the whole namespace they administer', () => {
    expect(person(3).access).toEqual([{ namespace: 'bigproject', path: '/', permission: 'write', via: [{ kind: 'admin' }] }]);
  });

  it('a person with nothing has an empty summary, so the card says No access yet', () => {
    expect(person(1).access).toEqual([]);
    expect(accessSummary(person(1))).toBe('');
  });

  it('per namespace: admins first, then everyone who reaches it, plus the groups with access', () => {
    const view = dir.byNamespace('bigproject');
    expect(view.members.map((m) => [m.person.user.username, m.isAdmin])).toEqual([['sam', true], ['alex', false]]);
    expect(dir.byNamespace('demo').groups.map((g) => g.group.name)).toEqual(['qa-team']);
    // A group with no members still shows as having access.
    expect(dir.byNamespace('team_space').groups.map((g) => g.group.name)).toEqual(['writers']);
    expect(dir.byNamespace('team_space').members).toEqual([]);
  });

  it('finds people by name, email or group', () => {
    expect(dir.people.filter((p) => matchesPerson(p, 'qa')).map((p) => p.user.username)).toEqual(['alex', 'jo']);
    expect(dir.people.filter((p) => matchesPerson(p, 'SAM@')).map((p) => p.user.username)).toEqual(['sam']);
    expect(dir.people.filter((p) => matchesPerson(p, '')).length).toBe(4);
  });

  it('write beats read whichever comes first', () => {
    expect(strongerPermission('read', 'write')).toBe('write');
    expect(strongerPermission('write', 'read')).toBe('write');
  });
});

describe('git backup per namespace', () => {
  const connections = [
    { id: 7, name: 'GitLab acme', base_url: 'https://gitlab.com/acme/' },
    { id: 8, name: 'Deployment default', base_url: 'https://git.example/notes', implicit_namespaces: ['legacy'] },
  ];
  const workspaces = [
    { id: 1, namespace: 'team-a', group_id: 7, git_enabled: true },
    { id: 2, namespace: 'solo', remote_url: 'https://github.com/me/solo.git', git_enabled: true },
    { id: 3, namespace: 'me@x', is_personal: true, remote_url: 'https://x/me.git' },
  ];

  it('a namespace in a connection mirrors to <base>/<namespace>.git', () => {
    const b = gitBackupFor('team-a', workspaces, connections);
    expect([b.kind, b.connection.name, b.repo]).toEqual(['connection', 'GitLab acme', 'https://gitlab.com/acme/team-a.git']);
  });

  it('a namespace with its own repository shows that repository', () => {
    expect(gitBackupFor('solo', workspaces, connections)).toMatchObject({ kind: 'own', repo: 'https://github.com/me/solo.git' });
  });

  it('the deployment default covers namespaces with no row of their own', () => {
    expect(gitBackupFor('legacy', workspaces, connections)).toMatchObject({ kind: 'default', repo: 'https://git.example/notes/legacy.git' });
  });

  it('a personal workspace is not offered as a namespace backup, and nothing else means none', () => {
    expect(gitBackupFor('me@x', workspaces, connections).kind).toBe('none');
    expect(gitBackupFor('other', workspaces, connections).kind).toBe('none');
  });
});
