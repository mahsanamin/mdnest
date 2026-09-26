// How much of the board's List view to paint — pure, no React.
//
// The List view put every task into the DOM: a big workspace (6,327 open
// tasks) froze the app for ~10 seconds on the click, while Kanban — whose
// columns paint 100 cards at a time — stayed instant. Same fix as the
// columns: paint the first `limit` tasks, keep note groups intact up to the
// cut (a group straddling it shows its first items), and report how many are
// hidden so the "Show more" button can say so. Filters still run over every
// task, so nothing is unreachable.
export const LIST_PAGE = 200;

export function pageGroups(groups, limit) {
  const shown = [];
  let left = limit;
  let total = 0;
  for (const g of groups) {
    total += g.items.length;
    if (left <= 0) continue;
    const items = g.items.length <= left ? g.items : g.items.slice(0, left);
    shown.push(items === g.items ? g : { ...g, items });
    left -= items.length;
  }
  return { shown, hidden: Math.max(0, total - limit) };
}
