import { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { cardKey } from './cardKey';
import TaskCard from './TaskCard';

// How many cards a column paints before it stops and offers a button.
//
// A column is a plain list, so its whole contents used to go into the DOM: a
// namespace with ~12k tasks put 6,313 cards and ~50k nodes on the page, which
// made the board slow to open and every keystroke in the filter box expensive.
// Nobody reads the six-thousandth card, but the browser still pays for it.
// Rendering a page at a time keeps the DOM small without hiding anything —
// the count in the header is always the true total, and the button reveals
// the rest. Chosen over a virtualised list because that needs a dependency
// and breaks find-in-page and drag-and-drop.
const PAGE = 100;

// BoardColumn is one kanban column: a droppable target that lists its task
// cards, with a collapse toggle and a live count.
export default function BoardColumn({ column, tasks, canWrite, onOpen, onToggleStep, onEdit, resolve, onDelete, collapsed, onToggleCollapse }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: !canWrite });
  // Deliberately not reset when the task list changes: a filter narrowing the
  // list can only shrink it below `shown`, which is harmless, and resetting on
  // every change would collapse the user's expansion each time they ticked a
  // checkbox.
  const [shown, setShown] = useState(PAGE);
  return (
    <div ref={setNodeRef} className={`tb-column${isOver ? ' over' : ''}${collapsed ? ' collapsed' : ''}`}>
      <div className="tb-column-head" onClick={collapsed ? onToggleCollapse : undefined}>
        <button
          type="button"
          className="tb-column-collapse"
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }}
          title={collapsed ? 'Expand column' : 'Collapse column'}
          aria-expanded={!collapsed}
        >
          {collapsed ? '\u25B8' : '\u25BE'}
        </button>
        <span className="tb-column-title">{column.title}</span>
        <span className="tb-column-count">{tasks.length}</span>
      </div>
      {!collapsed && (
        <div className="tb-column-body">
          {tasks.slice(0, shown).map((t) => (
            <TaskCard key={cardKey(t)} task={t} canWrite={canWrite} onOpen={onOpen} onToggleStep={onToggleStep} onEdit={onEdit} resolve={resolve} onDelete={onDelete} />
          ))}
          {tasks.length > shown && (
            <button
              type="button"
              className="tb-column-more"
              onClick={() => setShown((n) => n + PAGE)}
            >
              Show {Math.min(PAGE, tasks.length - shown)} more
              <span> · {tasks.length - shown} hidden</span>
            </button>
          )}
          {tasks.length === 0 && <div className="tb-column-empty">No tasks</div>}
        </div>
      )}
    </div>
  );
}
