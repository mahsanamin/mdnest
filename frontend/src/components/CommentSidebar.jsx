import { useState, useCallback, useRef, useEffect } from 'react';
import { createComment, resolveComment, deleteComment } from '../api.js';

function CommentSidebar({ comments, ns, currentPath, onRefresh, onClose, userInfo, pendingSelection, onSelectionConsumed }) {
  const [newComment, setNewComment] = useState('');
  const [adding, setAdding] = useState(false);
  const textareaRef = useRef(null);

  // Auto-focus textarea when sidebar opens with a pending selection
  useEffect(() => {
    if (pendingSelection && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [pendingSelection]);

  const handleAdd = useCallback(async () => {
    if (!newComment.trim() || !ns || !currentPath) return;
    setAdding(true);
    try {
      await createComment(ns, currentPath, {
        rangeStart: pendingSelection?.rangeStart || 0,
        rangeEnd: pendingSelection?.rangeEnd || 0,
        anchorText: pendingSelection?.anchorText || '',
        body: newComment.trim(),
      });
      setNewComment('');
      if (onSelectionConsumed) onSelectionConsumed();
      if (onRefresh) onRefresh();
    } catch (e) {
      console.error('Failed to add comment:', e);
    } finally {
      setAdding(false);
    }
  }, [newComment, ns, currentPath, onRefresh]);

  const handleResolve = useCallback(async (id, resolved) => {
    try {
      await resolveComment(ns, currentPath, id, resolved);
      if (onRefresh) onRefresh();
    } catch (e) {
      console.error('Failed to resolve comment:', e);
    }
  }, [ns, currentPath, onRefresh]);

  const handleDelete = useCallback(async (id) => {
    try {
      await deleteComment(ns, currentPath, id);
      if (onRefresh) onRefresh();
    } catch (e) {
      console.error('Failed to delete comment:', e);
    }
  }, [ns, currentPath, onRefresh]);

  const activeComments = (comments || []).filter(c => !c.resolved);
  const resolvedComments = (comments || []).filter(c => c.resolved);

  return (
    <div className="comment-sidebar">
      <div className="comment-sidebar-header">
        <h3>Comments</h3>
        <button className="comment-sidebar-close" onClick={onClose}>&times;</button>
      </div>

      <div className="comment-sidebar-add">
        {pendingSelection?.anchorText && (
          <div className="comment-anchor-preview">
            &ldquo;{pendingSelection.anchorText.slice(0, 100)}{pendingSelection.anchorText.length > 100 ? '...' : ''}&rdquo;
          </div>
        )}
        <textarea
          ref={textareaRef}
          placeholder={pendingSelection ? "Comment on this selection..." : "Add a general comment..."}
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAdd(); } }}
          rows={2}
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newComment.trim()}
        >
          {adding ? 'Adding...' : 'Comment'}
        </button>
      </div>

      <div className="comment-sidebar-list">
        {activeComments.length === 0 && resolvedComments.length === 0 && (
          <div className="comment-empty">No comments yet</div>
        )}

        {activeComments.map((c) => (
          <div key={c.id} className="comment-item">
            <div className="comment-item-header">
              <span className="comment-author">{c.author}</span>
              <span className="comment-time">{formatTime(c.createdAt)}</span>
            </div>
            {c.anchorText && (
              <div className="comment-anchor">&ldquo;{c.anchorText.slice(0, 60)}{c.anchorText.length > 60 ? '...' : ''}&rdquo;</div>
            )}
            <div className="comment-body">{c.body}</div>
            <div className="comment-actions">
              {c.anchorText && (
                <button onClick={() => {
                  // Clear any existing selection first
                  window.getSelection().removeAllRanges();
                  // Use browser's native find — highlights text exactly like Cmd+F
                  // Doesn't modify DOM, doesn't appear in print
                  window.find(c.anchorText, false, false, true);
                }}>Go to</button>
              )}
              <button onClick={() => handleResolve(c.id, true)}>Resolve</button>
              {userInfo && (userInfo.role === 'admin' || userInfo.id === c.authorId) && (
                <button className="danger" onClick={() => handleDelete(c.id)}>Delete</button>
              )}
            </div>
          </div>
        ))}

        {resolvedComments.length > 0 && (
          <>
            <div className="comment-section-label">Resolved</div>
            {resolvedComments.map((c) => (
              <div key={c.id} className="comment-item resolved">
                <div className="comment-item-header">
                  <span className="comment-author">{c.author}</span>
                  <span className="comment-time">{formatTime(c.createdAt)}</span>
                </div>
                <div className="comment-body">{c.body}</div>
                <div className="comment-actions">
                  <button onClick={() => handleResolve(c.id, false)}>Reopen</button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString();
}

export default CommentSidebar;
