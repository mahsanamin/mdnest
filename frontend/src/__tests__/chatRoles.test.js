import { describe, it, expect } from 'vitest';
import { CHAT_ROLES, applyRole, roleById } from '../chatRoles.js';
import { agentInstructions } from '../chat.js';

describe('agent role templates', () => {
  it('has the seven roles, each with a short trait and a valid agent name', () => {
    expect(CHAT_ROLES.map((r) => r.label)).toEqual(['Main Leader', 'Spec Expert', 'Analyzer', 'Lead Coder', 'Coder', 'Lead QA', 'QA']);
    for (const r of CHAT_ROLES) {
      expect(r.name).toMatch(/^[\w.-]+$/);
      expect(r.trait.length).toBeLessThanOrEqual(240); // one or two lines
      expect(r.trait).not.toMatch(/[<>]/); // pasted into an agent
    }
  });
  it('picking a role fills empty fields', () => {
    expect(applyRole({ name: '', intent: '', prevRoleId: '' }, 'lead-coder'))
      .toEqual({ name: 'lead-coder', intent: roleById('lead-coder').trait });
  });
  it('switching roles replaces the previous defaults but keeps what the person typed', () => {
    const a = applyRole({ name: '', intent: '', prevRoleId: '' }, 'coder');
    const b = applyRole({ ...a, prevRoleId: 'coder' }, 'qa');
    expect(b).toEqual({ name: 'qa-1', intent: roleById('qa').trait });
    const typed = applyRole({ name: 'codxu', intent: 'Fix the login bug.', prevRoleId: 'coder' }, 'qa');
    expect(typed).toEqual({ name: 'codxu', intent: 'Fix the login bug.' });
  });
  it('clearing the role clears untouched defaults', () => {
    const a = applyRole({ name: '', intent: '', prevRoleId: '' }, 'analyzer');
    expect(applyRole({ ...a, prevRoleId: 'analyzer' }, '')).toEqual({ name: '', intent: '' });
  });
  it('a lead trait in the prompt still has no angle brackets and tells helpers how to leave', () => {
    const s = agentInstructions('mini', 'notes', 'Chats/team.md', 'lead-coder', roleById('lead-coder').trait);
    expect(s).not.toMatch(/[<>]/);
    expect(s).toContain('Your job in this chat:\n  You lead the coding.');
    expect(s).toMatch(/Leave only when your lead or a human says you are done/);
  });
});
