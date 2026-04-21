import { useState, useCallback, useRef, useEffect } from 'react';
import { createComment, resolveComment, deleteComment } from '../api.js';

function CommentSidebar({ comments, ns, currentPath, onRefresh, onClose, userInfo, pendingSelection, onSelectionConsumed, onGoTo, highlightedId, onHighlightConsumed }) {
  const [newComment, setNewComment] = useState('');
  const [adding, setAdding] = useState(false);
  const [replyingTo, setReplyingTo] = useState(null); // parent comment id
  const [replyBody, setReplyBody] = useState('');
  const [replyPosting, setReplyPosting] = useState(false);
  const [flashingId, setFlashingId] = useState(null);
  const textareaRef = useRef(null);
  const replyRef = useRef(null);
  const itemRefs = useRef({}); // commentId -> DOM node

  useEffect(() => {
    if (pendingSelection && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [pendingSelection]);

  useEffect(() => {
    if (replyingTo && replyRef.current) {
      replyRef.current.focus();
    }
  }, [replyingTo]);

  // When a comment is requested to be highlighted (click-through from editor
  // or Go To), scroll its card into view and briefly flash it.
  useEffect(() => {
    if (!highlightedId) return;
    // Walk up: if this is a reply, scroll to the parent thread card.
    let targetId = highlightedId;
    const target = (comments || []).find((c) => c.id === highlightedId);
    if (target && target.parentId) targetId = target.parentId;
    const node = itemRefs.current[targetId];
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setFlashingId(targetId);
    const t = setTimeout(() => {
      setFlashingId(null);
      if (onHighlightConsumed) onHighlightConsumed();
    }, 1600);
    return () => clearTimeout(t);
  }, [highlightedId, comments, onHighlightConsumed]);

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
  }, [newComment, ns, currentPath, pendingSelection, onRefresh, onSelectionConsumed]);

  const handleReply = useCallback(async (parent) => {
    if (!replyBody.trim() || !ns || !currentPath) return;
    setReplyPosting(true);
    try {
      await createComment(ns, currentPath, {
        parentId: parent.id,
        rangeStart: parent.rangeStart,
        rangeEnd: parent.rangeEnd,
        anchorText: parent.anchorText,
        body: replyBody.trim(),
      });
      setReplyBody('');
      setReplyingTo(null);
      if (onRefresh) onRefresh();
    } catch (e) {
      console.error('Failed to add reply:', e);
    } finally {
      setReplyPosting(false);
    }
  }, [replyBody, ns, currentPath, onRefresh]);

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

  // Group comments into threads: top-level (no parentId) with their replies.
  const threads = (comments || []).reduce((acc, c) => {
    if (!c.parentId) {
      acc.push({ ...c, replies: [] });
    }
    return acc;
  }, []);
  const byId = new Map(threads.map((t) => [t.id, t]));
  for (const c of comments || []) {
    if (c.parentId && byId.has(c.parentId)) {
      byId.get(c.parentId).replies.push(c);
    }
  }
  // Sort replies oldest-first within each thread
  for (const t of threads) {
    t.replies.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  const activeThreads = threads.filter((t) => !t.resolved);
  const resolvedThreads = threads.filter((t) => t.resolved);

  const canDelete = (c) => userInfo && (userInfo.role === 'admin' || userInfo.id === c.authorId);

  const renderReply = (r) => (
    <div key={r.id} className="comment-reply">
      <div className="comment-item-header">
        <span className="comment-author">{r.author}</span>
        <span className="comment-time">{formatTime(r.createdAt)}</span>
      </div>
      <div className="comment-body">{r.body}</div>
      {canDelete(r) && (
        <div className="comment-actions">
          <button className="danger" onClick={() => handleDelete(r.id)}>Delete</button>
        </div>
      )}
    </div>
  );

  const renderThread = (c) => (
    <div
      key={c.id}
      ref={(el) => { itemRefs.current[c.id] = el; }}
      className={`comment-item${c.resolved ? ' resolved' : ''}${flashingId === c.id ? ' flashing' : ''}`}
    >
      <div className="comment-item-header">
        <span className="comment-author">{c.author}</span>
        <span className="comment-time">{formatTime(c.createdAt)}</span>
      </div>
      {c.anchorText && (
        <div className="comment-anchor">&ldquo;{c.anchorText.slice(0, 60)}{c.anchorText.length > 60 ? '...' : ''}&rdquo;</div>
      )}
      <div className="comment-body">{c.body}</div>

      {c.replies.length > 0 && (
        <div className="comment-thread">
          {c.replies.map(renderReply)}
        </div>
      )}

      <div className="comment-actions">
        {c.anchorText && onGoTo && (
          <button onClick={() => onGoTo(c)}>Go to</button>
        )}
        {!c.resolved && (
          <button onClick={() => { setReplyingTo(c.id); setReplyBody(''); }}>Reply</button>
        )}
        {!c.resolved && (
          <button onClick={() => handleResolve(c.id, true)}>Resolve</button>
        )}
        {c.resolved && (
          <button onClick={() => handleResolve(c.id, false)}>Reopen</button>
        )}
        {canDelete(c) && (
          <button className="danger" onClick={() => handleDelete(c.id)}>Delete</button>
        )}
      </div>

      {replyingTo === c.id && (
        <div className="comment-reply-form">
          <textarea
            ref={replyRef}
            placeholder="Reply..."
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleReply(c); }
              if (e.key === 'Escape') { setReplyingTo(null); setReplyBody(''); }
            }}
            rows={2}
          />
          <div className="comment-reply-actions">
            <button onClick={() => handleReply(c)} disabled={replyPosting || !replyBody.trim()}>
              {replyPosting ? 'Sending...' : 'Send'}
            </button>
            <button onClick={() => { setReplyingTo(null); setReplyBody(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );

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
        {activeThreads.length === 0 && resolvedThreads.length === 0 && (
          <div className="comment-empty">No comments yet</div>
        )}

        {activeThreads.map(renderThread)}

        {resolvedThreads.length > 0 && (
          <>
            <div className="comment-section-label">Resolved</div>
            {resolvedThreads.map(renderThread)}
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
