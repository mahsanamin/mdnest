import { describe, it, expect } from 'vitest';
import { relocateTask, withStableIds, cardKey } from '../components/cardKey';

const t = (line, raw, extra = {}) => ({ path: 'a.md', line, raw, ...extra });

describe('relocateTask', () => {
  it('finds a task whose line shifted after a status line was written above it', () => {
    // Moving A wrote "  - status: doing" under it, pushing B from 4 to 5.
    const fresh = [t(3, '- [ ] A'), t(5, '- [ ] B')];
    expect(relocateTask(fresh, t(4, '- [ ] B'))).toEqual(t(5, '- [ ] B'));
  });
  it('prefers the nearest copy when the same text appears twice', () => {
    const fresh = [t(2, '- [ ] same'), t(9, '- [ ] same')];
    expect(relocateTask(fresh, t(8, '- [ ] same')).line).toBe(9);
  });
  it('never crosses notes or namespaces', () => {
    expect(relocateTask([{ ...t(4, '- [ ] B'), path: 'b.md' }], t(4, '- [ ] B'))).toBeNull();
    expect(relocateTask([t(4, '- [ ] B', { namespace: 'x' })], t(4, '- [ ] B', { namespace: 'y' }))).toBeNull();
  });
  it('returns null when the task was edited or removed', () => {
    expect(relocateTask([t(4, '- [ ] B edited')], t(4, '- [ ] B'))).toBeNull();
  });
});

describe('withStableIds', () => {
  it('keeps a card\'s identity when a status line shifts it down', () => {
    const first = withStableIds([], [t(3, '- [ ] A'), t(4, '- [ ] B')]);
    const after = withStableIds(first, [t(3, '- [ ] A', { column: 'doing' }), t(5, '- [ ] B')]);
    expect(cardKey(after[1])).toBe(cardKey(first[1]));
    expect(cardKey(after[0])).toBe(cardKey(first[0]));
  });
  it('keeps identical lines in one note distinct and in order', () => {
    const first = withStableIds([], [t(2, '- [ ] same'), t(5, '- [ ] same')]);
    expect(cardKey(first[0])).not.toBe(cardKey(first[1]));
    const after = withStableIds(first, [t(3, '- [ ] same'), t(7, '- [ ] same')]);
    expect(after.map(cardKey)).toEqual(first.map(cardKey));
  });
  it('gives an edited or ticked task a new identity', () => {
    const first = withStableIds([], [t(3, '- [ ] A')]);
    const after = withStableIds(first, [t(3, '- [x] A')]);
    expect(cardKey(after[0])).not.toBe(cardKey(first[0]));
  });
});
