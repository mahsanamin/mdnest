// Role templates for Connect an agent. Picking one fills a suggested name and
// a one- or two-line trait into the panel; both stay editable, and the trait
// reaches the prompt the same way a typed intent does ("Your job in this
// chat"). The leads may start helpers as their own sub-agents, who join the
// same chat with the same steps and leave when their lead says they are done.
//
// Plain words only: these are pasted into an agent, and the prompt they join
// is checked for angle brackets.
export const CHAT_ROLES = Object.freeze([
  {
    id: 'main-leader',
    label: 'Main Leader',
    name: 'main-leader',
    trait: 'You lead this chat. Break the goal into tasks, give them to the leads by @name, keep track of who is doing what, and report progress and decisions to the humans. You decide when the work is done.',
  },
  {
    id: 'spec-expert',
    label: 'Spec Expert',
    name: 'spec-expert',
    trait: 'You own the requirements. Turn requests into clear acceptance criteria, answer scope questions, and ask a human when something is unclear.',
  },
  {
    id: 'analyzer',
    label: 'Analyzer',
    name: 'analyzer',
    trait: 'You investigate. Read the code, data or logs to find causes and facts, and post short findings with evidence. You do not change code.',
  },
  {
    id: 'lead-coder',
    label: 'Lead Coder',
    name: 'lead-coder',
    trait: 'You lead the coding. Split the work, start helper coders as your own sub-agents (coder-1, coder-2, ...) who join this chat with these same steps, review what they deliver, and tell each one to leave when its task is done.',
  },
  {
    id: 'coder',
    label: 'Coder',
    name: 'coder-1',
    trait: 'You do one task your lead gives you. Post a short plan, do it, report what changed and how you checked it, then leave when your lead says you are done.',
  },
  {
    id: 'lead-qa',
    label: 'Lead QA',
    name: 'lead-qa',
    trait: 'You lead testing. Plan the tests from the acceptance criteria, start helper testers as your own sub-agents (qa-1, qa-2, ...) for separate areas, collect their results, and report pass or fail to the main leader.',
  },
  {
    id: 'qa',
    label: 'QA',
    name: 'qa-1',
    trait: 'You test one area your QA lead gives you. Report each problem with steps to reproduce and expected vs actual, then leave when your lead says you are done.',
  },
]);

export function roleById(id) {
  return CHAT_ROLES.find((r) => r.id === id) || null;
}

// What picking a role does to the panel's two fields. A field the person has
// typed into is kept; one that is empty or still holds the previous role's
// default is replaced, so switching roles back and forth just works.
export function applyRole({ name, intent, prevRoleId }, nextRoleId) {
  const prev = roleById(prevRoleId);
  const next = roleById(nextRoleId);
  const untouched = (value, def) => !String(value || '').trim() || (def != null && value === def);
  return {
    name: untouched(name, prev?.name) ? (next?.name || '') : name,
    intent: untouched(intent, prev?.trait) ? (next?.trait || '') : intent,
  };
}
