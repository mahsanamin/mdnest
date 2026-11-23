import { useRef, useEffect, useCallback } from 'react';
import StickyCard from './StickyCard.jsx';
import StickiesLoadError from './StickiesLoadError.jsx';
import {
  newSticky,
  addSticky,
  editSticky,
  removeSticky,
  isBoardFull,
  MAX_STICKIES,
} from '../stickies.js';

const RESIZE_STEP = 16; // px per arrow key on the resize handle

const TAB_LABELS = { chat: 'Chat', stickies: 'Stickies', pages: 'Pages' };

// The right-edge side panel. Its first job was the sticky board as a drawer,
// the quick way in for jotting one down without leaving the note you are
// reading; the full-screen corkboard (StickiesBoard) is the same cards laid
// out spatially, and the Expand button swaps between them. When chat can dock
// here, the panel also has a Chat tab (`chat` is what it shows), and with HTML
// pages on a Pages tab (`pages`). `tabs` lists the tabs offered, in order;
// with one tab there is no tab bar. One panel with tabs rather than a second
// drawer: two panels on one edge would have to fight over the same strip of
// screen.
//
// width / minWidth / maxWidth come from App per tab, already clamped to what
// leaves the editor usable, so the drag and the arrow keys only clamp again.
function StickiesPanel({
  stickies, onChange, onClose, onExpand, saveState, loadState, onRetry,
  width, minWidth = 260, maxWidth = 760, onWidthChange,
  tab = 'stickies', onTab, chat, pages, tabs: offered,
}) {
  const focusIdRef = useRef(null); // card to focus after the next render
  const tabRefs = useRef({});
  const clampWidth = (w) => Math.min(maxWidth, Math.max(minWidth, w));
  const tabs = onTab && offered && offered.length > 1 ? offered : null;
  const showChat = tab === 'chat' && !!tabs && tabs.includes('chat');
  const showPages = tab === 'pages' && !!tabs && tabs.includes('pages');
  const showStickies = !showChat && !showPages;

  const full = isBoardFull(stickies);

  const handleAdd = useCallback(() => {
    if (full) return;
    const card = newSticky();
    // Focus is deferred to an effect rather than done here: the textarea does
    // not exist until React has rendered the new card.
    focusIdRef.current = card.id;
    onChange(addSticky(stickies, card));
  }, [stickies, onChange, full]);

  useEffect(() => {
    if (!focusIdRef.current) return;
    const node = document.querySelector(`[data-sticky-id="${focusIdRef.current}"] .sticky-title`);
    focusIdRef.current = null;
    if (node) node.focus();
  }, [stickies]);

  // Escape closes the panel, but only once nothing smaller is open: a popup
  // or a menu closes first (they handle Escape themselves), then the panel.
  const onKeyDown = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('.context-menu, .chat-dialog-backdrop')) return;
    e.stopPropagation();
    onClose();
  };

  // Real tabs: arrow keys move between them and select (the WAI-ARIA tabs
  // pattern with automatic activation).
  const onTabKey = (e) => {
    const i = tabs.indexOf(tab);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    onTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      className={`stickies-panel${showChat ? ' side-panel-chat' : ''}${showPages ? ' side-panel-pages' : ''}`}
      style={width ? { width } : undefined}
      onKeyDown={onKeyDown}
      data-testid="side-panel"
    >
      {onWidthChange && (
        <div
          className="stickies-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the side panel"
          aria-valuenow={width}
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          tabIndex={0}
          title="Drag, or use the arrow keys, to resize"
          onKeyDown={(e) => {
            // Anchored to the right edge: Left widens, Right narrows.
            let next = null;
            if (e.key === 'ArrowLeft') next = (width || minWidth) + RESIZE_STEP;
            else if (e.key === 'ArrowRight') next = (width || minWidth) - RESIZE_STEP;
            else if (e.key === 'Home') next = minWidth;
            else if (e.key === 'End') next = maxWidth;
            if (next === null) return;
            e.preventDefault();
            onWidthChange(clampWidth(next));
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startWidth = width || 320;
            const onMove = (ev) => {
              // Anchored to the right edge, so dragging left widens it.
              onWidthChange(clampWidth(startWidth + startX - ev.clientX));
            };
            const onUp = () => {
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
              document.body.style.cursor = '';
              document.body.style.userSelect = '';
            };
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          }}
        />
      )}

      <div className="stickies-header">
        {tabs ? (
          <div className="side-panel-tabs" role="tablist" aria-label="Side panel">
            {tabs.map((t) => (
              <button
                key={t}
                ref={(el) => { tabRefs.current[t] = el; }}
                id={`side-panel-tab-${t}`}
                role="tab"
                className={`side-panel-tab${tab === t ? ' active' : ''}`}
                aria-selected={tab === t}
                aria-controls="side-panel-body"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => onTab(t)}
                onKeyDown={onTabKey}
                data-testid={`side-panel-tab-${t}`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        ) : (
          <h3>Stickies</h3>
        )}
        {showStickies && <>
          {/* The save state is shown, not hidden behind a silent autosave. The
              board is the one place in mdnest holding content that exists
              nowhere else — no namespace, no git remote — so "did that land?"
              is a fair question and an error must be visible, not console-only. */}
          <span className={`stickies-save-state ${saveState}`}>
            {saveState === 'saving' && 'Saving…'}
            {saveState === 'error' && 'Not saved'}
          </span>
          <button
            className="stickies-expand"
            onClick={onExpand}
            title="Open the full board"
            aria-label="Open the full board"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
        </>}
        <button
          className="stickies-close"
          onClick={onClose}
          aria-label={tabs ? 'Close the side panel' : 'Close stickies'}
          title={tabs ? (showChat ? 'Close the side panel (Esc). The chat and its draft are kept.' : 'Close the side panel (Esc)') : 'Close stickies'}
        >&times;</button>
      </div>

      <div
        className="side-panel-body"
        id="side-panel-body"
        role={tabs ? 'tabpanel' : undefined}
        aria-labelledby={tabs ? `side-panel-tab-${tab}` : undefined}
      >
        {showChat ? chat : showPages ? pages : <>
          <div className="stickies-add-row">
            <button
              className="stickies-add"
              onClick={handleAdd}
              disabled={full || loadState !== 'ready'}
              title={full ? `A board holds at most ${MAX_STICKIES} stickies` : 'Add a sticky'}
            >
              + New sticky
            </button>
          </div>

          <div className="stickies-list">
            {loadState === 'error' && <StickiesLoadError onRetry={onRetry} />}
            {loadState === 'loading' && <div className="stickies-empty">Loading…</div>}

            {loadState === 'ready' && stickies.length === 0 && (
              <div className="stickies-empty">
                <p>No stickies yet.</p>
                {/* Said here rather than in the docs alone: this is the one place
                    in mdnest where content is deliberately not backed up, and the
                    moment to know that is before you paste something into it. */}
                <p className="stickies-empty-note">
                  Private to you and kept on this server only — stickies are never
                  synced to a git remote. Anything you need backed up belongs in a note.
                </p>
              </div>
            )}

            {loadState === 'ready' && stickies.map((c) => (
              <StickyCard
                key={c.id}
                card={c}
                onCardChange={(next) => onChange(editSticky(stickies, c.id, next))}
                onDelete={() => onChange(removeSticky(stickies, c.id))}
              />
            ))}
          </div>
        </>}
      </div>
    </div>
  );
}

export default StickiesPanel;
