import { useDroppable } from '@dnd-kit/core';
import { cardKey } from './cardKey';
import TaskCard from './TaskCard';

// BoardColumn is one kanban column: a droppable target that lists its task
// cards, with a collapse toggle and a live count.
export default function BoardColumn({ column, tasks, canWrite, onOpen, onToggleStep, onEdit, resolve, onDelete, collapsed, onToggleCollapse }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id, disabled: !canWrite });
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
          {tasks.map((t) => (
            <TaskCard key={cardKey(t)} task={t} canWrite={canWrite} onOpen={onOpen} onToggleStep={onToggleStep} onEdit={onEdit} resolve={resolve} onDelete={onDelete} />
          ))}
          {tasks.length === 0 && <div className="tb-column-empty">No tasks</div>}
        </div>
      )}
    </div>
  );
}
