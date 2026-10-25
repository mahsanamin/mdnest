// Where a caret should go when a textarea's text is replaced from outside
// (the CLI or an agent changed the note): text before the change keeps its
// offset, text after it moves by the change's length, and a caret inside the
// changed part goes to its end. Without this, React's value update put the
// caret at the end of the note while the person was typing in the middle.
export function mapCaret(before, after, offset) {
  if (before === after) return offset;
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p += 1;
  if (offset <= p) return offset;
  let s = 0;
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s += 1;
  if (offset >= before.length - s) return offset + (after.length - before.length);
  return after.length - s;
}
