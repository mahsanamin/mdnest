import { describe, it, expect } from 'vitest';
import { pageGroups } from '../listPage';

const g = (path, n) => ({ path, items: Array.from({ length: n }, (_, i) => `${path}-${i}`) });

describe('pageGroups', () => {
  it('shows everything when it fits', () => {
    const groups = [g('a', 3), g('b', 2)];
    expect(pageGroups(groups, 10)).toEqual({ shown: groups, hidden: 0 });
  });
  it('cuts at the limit, keeping whole groups before the cut', () => {
    const { shown, hidden } = pageGroups([g('a', 3), g('b', 5), g('c', 4)], 6);
    expect(shown.map((x) => [x.path, x.items.length])).toEqual([['a', 3], ['b', 3]]);
    expect(hidden).toBe(6);
  });
  it('never paints more than the limit however many notes there are', () => {
    const many = Array.from({ length: 500 }, (_, i) => g(`n${i}`, 13));
    const { shown, hidden } = pageGroups(many, 200);
    expect(shown.reduce((s, x) => s + x.items.length, 0)).toBe(200);
    expect(hidden).toBe(500 * 13 - 200);
  });
});
