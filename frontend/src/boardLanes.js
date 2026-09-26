// Which kanban column a drag is aimed at — pure, no React, no dnd-kit.
//
// dnd-kit's default collision rule picks the droppable the dragged card's
// rectangle overlaps most. On this board that made most drops miss: a column
// is only as tall as its cards, so releasing in the empty space below a short
// column (or below "No tasks") overlapped nothing and the card snapped back,
// and the collapsed Done strip is narrower than the card, so the wide
// neighbouring column always won the overlap. People aim with the pointer,
// not with the card's rectangle, so the pointer decides: anywhere in a
// column's vertical lane, from its top edge down, is that column.

// laneAt returns the id of the column whose lane contains the pointer, or
// null. `rects` is an iterable of [id, {left, right, top}].
export function laneAt(pointer, rects) {
  if (!pointer) return null;
  for (const [id, r] of rects) {
    if (!r) continue;
    if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top) return id;
  }
  return null;
}

// edgeScrollStep is how far (px, signed) to scroll the board this frame while
// a card is dragged: nothing unless the pointer is within `zone` px of the
// board's left or right edge, then faster the closer it gets, up to `max`.
// dnd-kit's own auto-scroll is off on this board — it paired the board with
// the SOURCE column's box, so leaving the starting column counted as "at the
// edge" and slid the board sideways under the pointer mid-drag.
export function edgeScrollStep(pointerX, rect, zone = 50, max = 18) {
  if (pointerX == null || !rect) return 0;
  const fromLeft = pointerX - rect.left;
  const fromRight = rect.right - pointerX;
  if (fromLeft < zone && fromLeft > -zone) return -Math.ceil(max * (1 - Math.max(fromLeft, 0) / zone));
  if (fromRight < zone && fromRight > -zone) return Math.ceil(max * (1 - Math.max(fromRight, 0) / zone));
  return 0;
}
