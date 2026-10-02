import { useState, useCallback, useEffect, useRef } from 'react';

function Toolbar({ currentPath, onToggleSidebar, onRevealInTree, onChangePassword, onManageUsers, onRename, onDelete, viewMode, onViewModeChange, editorMode, onEditorModeChange, onRefresh, wsStatus, commentCount, onToggleComments, onToggleStickies, stickiesOpen, onSetBoardActive, boardActive, onSetChatsActive, chatsActive, chatsBackLabel, marpLocked, liveLockReason, mobileView, onMobileViewChange, drawingDoc, drawingSource, onDrawingSourceChange, theme, onToggleTheme }) {
  const [refreshing, setRefreshing] = useState(false);
  // Phone overflow menu. On a phone the bar keeps only what is used per note
  // (sidebar, filename, comments, the mode switch); every other control lives
  // in this menu. The menu is CSS-hidden on desktop, where everything fits.
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onDown = (e) => { if (moreRef.current && !moreRef.current.contains(e.target)) setMoreOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);
  const runMore = (fn) => () => { setMoreOpen(false); fn?.(); };
  const statusLabel = wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Reconnecting' : wsStatus === 'superseded' ? 'Session moved' : 'Offline';
  // The dot on the menu button: only for something that is wrong, so it
  // means "look inside" rather than being permanent decoration.
  const moreNeedsAttention = !!wsStatus && !!currentPath && wsStatus !== 'connected';
  const handleRefresh = useCallback(() => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    onRefresh().finally(() => setTimeout(() => setRefreshing(false), 2000));
  }, [refreshing, onRefresh]);

  // Allow flipping Basic/Live even when no file is open — so a user whose
  // Live-mode crashed on the previous file can pre-switch to Basic before
  // opening the next one. Requires viewMode !== 'preview' (editor isn't
  // visible in preview-only mode anyway).
  //
  // Hidden entirely while the board is open: they change how the open *file*
  // is edited, and the board has replaced it, so there is nothing for them to
  // act on. Leaving them visible-but-inert was the confusing part — they read
  // as view switches for what is on screen.
  // On a phone the same control also carries Preview (see below), so it must
  // show even when the desktop view mode is preview-only.
  const showEditorToggle = (viewMode !== 'preview' || !!onMobileViewChange) && onEditorModeChange && !boardActive && !chatsActive;
  // Phone only: one Basic | Live | Preview control instead of the Basic/Live
  // pair plus a full-width Edit/Preview row under the toolbar. Basic and Live
  // mean "edit, in this mode"; Preview means "read".
  const mobilePreview = !!onMobileViewChange && mobileView === 'preview';

  return (
    <div className={`toolbar${boardActive || chatsActive ? ' toolbar--view' : ''}${chatsActive ? ' toolbar--chats' : ''}`}>
      {/* Groups, not a flat row. Every control used to sit the same 0.5rem
          from its neighbour, so "Rename / Delete" read as no more related to
          each other than to the file path beside them, and the trailing icons
          read as a fourth unrelated thing. Related controls are now a
          .toolbar-group at --gap-within; the groups themselves are separated
          by --gap-between, four times wider. Nothing is added to the screen —
          the same buttons just stop competing for the eye. */}
      <div className="toolbar-group">
        <button className="toolbar-hamburger" onClick={onToggleSidebar} title="Toggle sidebar">
          &#9776;
        </button>
      {/* One button that swaps to name where it takes you: on a note it says
          Board, on the board it says Editor. A pair of buttons showed the
          inactive half permanently greyed for no benefit, and a single
          pressed/unpressed toggle never said what pressing it would do.
          The class follows the destination too (.toolbar-view-board takes you
          to the board, .toolbar-view-editor brings you back), so the name is
          about intent rather than which half is lit. */}
      {/* Chat mode has ONE exit, and it says where it goes: back to the note or
          board you came from. Board/Chats/Editor are hidden there, because
          leaving by switching to some other view is a side effect, not an
          exit. (On a phone the chats header carries the ←, see CSS.) */}
      {chatsActive && (
        <button
          className="toolbar-view-btn toolbar-chats-back"
          onClick={() => onSetChatsActive(false)}
          title={`Back to ${chatsBackLabel || 'the editor'}`}
        >
          <span aria-hidden="true">&#8592;</span>
          <span>Back to {chatsBackLabel || 'the editor'}</span>
        </button>
      )}
      {boardActive ? (
        <button
          className="toolbar-view-btn toolbar-view-editor"
          onClick={() => onSetBoardActive(false)}
          title={currentPath ? `Back to ${currentPath}` : 'Back to the editor'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
          <span>Editor</span>
        </button>
      ) : null}
      {onSetBoardActive && !boardActive && !chatsActive && (
        <button
          className="toolbar-view-btn toolbar-view-board"
          onClick={() => onSetBoardActive(true)}
          title="Task board for this workspace"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
          <span>Board</span>
        </button>
      )}
      {/* Chats sits beside Board and follows the same rule: the button names
          where it takes you, and on that view it is replaced by "Editor". */}
      {onSetChatsActive && !chatsActive && (
        <button
          className="toolbar-view-btn toolbar-view-chats"
          onClick={() => onSetChatsActive(true)}
          title="All chats"
        >
          {/* A conversation: a solid bubble in front of an outlined one,
              both ROUND. Comments use a square bubble with text lines and
              Stickies a yellow note, so the three side-by-side toolbar
              icons differ in shape, not just in detail. */}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <defs><mask id="chats-icon-dots"><rect width="24" height="24" fill="#fff"/><circle cx="6.3" cy="14" r="1.2" fill="#000"/><circle cx="9.6" cy="14" r="1.2" fill="#000"/><circle cx="12.9" cy="14" r="1.2" fill="#000"/></mask></defs>
            <path d="M9.2 5.6A7 7 0 0 1 21.3 12.9l.9 3.6-3.6-.9a7 7 0 0 1-1.8.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9.6 7.4a6.6 6.6 0 1 1-3.4 12.3L2.3 20.8l1.1-3.7A6.6 6.6 0 0 1 9.6 7.4z" fill="currentColor" mask="url(#chats-icon-dots)"/>
          </svg>
          <span>Chats</span>
        </button>
      )}
      </div>

      {showEditorToggle && (
        <div className="editor-mode-toggle">
          {/* A drawing is still a markdown file, so the toggle offers its two
              real views: the canvas, or the source behind it. Live is not one
              of them — the rich editor would reformat the scene JSON. */}
          {showEditorToggle && drawingDoc && (
            <>
              {/* Same order as the normal Basic|Live pair: the raw view on the
                  left, the rich one on the right. Basic means the same thing in
                  both — the plain text behind what you're looking at. */}
              <button
                className={drawingSource ? 'active' : ''}
                onClick={() => onDrawingSourceChange(true)}
                title="Markdown source behind this drawing"
              >Basic</button>
              <button
                className={!drawingSource ? 'active' : ''}
                onClick={() => onDrawingSourceChange(false)}
                title="Drawing canvas"
              >Drawing</button>
            </>
          )}
          {showEditorToggle && !drawingDoc && (
            <>
              <button
                className={editorMode === 'basic' && !mobilePreview ? 'active' : ''}
                onClick={() => { onEditorModeChange('basic'); onMobileViewChange?.('editor'); }}
                title="Plain text editor"
              >Basic</button>
              <button
                className={editorMode === 'live' && !mobilePreview ? 'active' : ''}
                onClick={() => { onEditorModeChange('live'); onMobileViewChange?.('editor'); }}
                disabled={marpLocked}
                title={marpLocked ? (liveLockReason || 'Disabled for Marp slides — the rich editor would reformat and break the deck') : 'Live rich editor'}
              >Live</button>
              {onMobileViewChange && (
                <button
                  className={mobilePreview ? 'active' : ''}
                  onClick={() => onMobileViewChange('preview')}
                  title="Rendered preview"
                >Preview</button>
              )}
            </>
          )}
        </div>
      )}
      {/* Phone only (CSS): on the board or the chats view the bar names that
          view instead of the note underneath it, which it is not showing. */}
      {(boardActive || chatsActive) && (
        <span className="toolbar-view-title">{boardActive ? 'Task board' : 'Chats'}</span>
      )}
      {/* Path display splits dir + basename so the filename never gets
          ellipsized away on narrow screens. .toolbar-path-dir shrinks
          and ellipsizes; .toolbar-path-base has flex-shrink: 0 so it
          stays visible even when the toolbar is cramped. Full path is
          on the title="" attribute for desktop hover reveal. */}
      <span className="toolbar-path" title={currentPath || ''}>
        {/* "No file selected" is guidance for an empty editor. On the board
            there is nothing to select a file for, so the prompt is just noise
            — the board is showing the whole workspace. */}
        {!currentPath && !boardActive && 'No file selected'}
        {currentPath && (() => {
          const idx = currentPath.lastIndexOf('/');
          const dir = idx >= 0 ? currentPath.substring(0, idx + 1) : '';
          const base = idx >= 0 ? currentPath.substring(idx + 1) : currentPath;
          return (
            <>
              {dir && <span className="toolbar-path-dir">{dir}</span>}
              <span className="toolbar-path-base">{base}</span>
            </>
          );
        })()}
        {currentPath && onRevealInTree && (
          <button
            className="toolbar-inline-reveal"
            onClick={onRevealInTree}
            title="Reveal in tree"
            aria-label="Reveal current file in the tree"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="7" />
              <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
              <line x1="12" y1="2" x2="12" y2="5" />
              <line x1="12" y1="19" x2="12" y2="22" />
              <line x1="2" y1="12" x2="5" y2="12" />
              <line x1="19" y1="12" x2="22" y2="12" />
            </svg>
          </button>
        )}
        {currentPath && (
          <button
            className={`toolbar-inline-refresh${refreshing ? ' spinning' : ''}`}
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh"
          >&#8635;</button>
        )}
        {currentPath && (onRename || onDelete) && (
          <span className="toolbar-path-actions">
            {onRename && <button className="toolbar-inline-action" onClick={onRename} title="Rename">Rename</button>}
            {onDelete && <button className="toolbar-inline-action danger" onClick={onDelete} title="Delete">Delete</button>}
          </span>
        )}
      </span>
      {/* View mode toggle is shown even without a file open so the user can
          never get trapped in a mode that crashed on the previous file. The
          buttons just mutate the persisted preference; they take effect
          when the next file is opened. */}
      {onViewModeChange && (
        <div className="toolbar-view-toggle">
          <button
            className={viewMode === 'editor' ? 'active' : ''}
            onClick={() => onViewModeChange('editor')}
            title="Editor only"
          >
            &#9998;
          </button>
          <button
            className={viewMode === 'split' ? 'active' : ''}
            onClick={() => onViewModeChange('split')}
            title="Split view"
          >
            &#9109;
          </button>
          <button
            className={viewMode === 'preview' ? 'active' : ''}
            onClick={() => onViewModeChange('preview')}
            title="Preview only"
          >
            &#9673;
          </button>
        </div>
      )}
      {/* Status and app-level utilities: not file actions, so they are their
          own group and carry a divider. */}
      <div className="toolbar-group toolbar-utility">
      {wsStatus && currentPath && (
        <span
          className={`ws-status ${wsStatus}`}
          title={wsStatus === 'connected' ? 'Live collaboration connected' : wsStatus === 'connecting' ? 'Reconnecting to live collaboration' : wsStatus === 'superseded' ? 'Session moved to another tab' : 'Live collaboration offline'}
        >
          <span className={`ws-status-dot ${wsStatus}`} />
          <span className="ws-status-text">
            {wsStatus === 'connected' ? 'Live' : wsStatus === 'connecting' ? 'Reconnecting' : wsStatus === 'superseded' ? 'Session moved' : 'Offline'}
          </span>
        </span>
      )}
      {currentPath && onToggleComments && (
        <button className="toolbar-comments" onClick={onToggleComments} title="Comments">
          {/* A note ON this file: square bubble with text lines. */}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 3H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 17h3v4l4.5-4H20a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 20 3z"/>
            <path d="M7 8h10M7 12h6"/>
          </svg>
          {commentCount > 0 && <span className="comment-badge">{commentCount}</span>}
        </button>
      )}
      {/* Not gated on currentPath, unlike Comments. Comments are about the
          open file; stickies are about the person, so the board has to be
          reachable from an empty editor and from the task board too — those
          are exactly the moments someone jots one down. */}
      {onToggleStickies && (
        <button
          className={`toolbar-stickies${stickiesOpen ? ' active' : ''}`}
          onClick={onToggleStickies}
          title="Stickies — your private notes on this server"
          aria-label="Stickies"
        >
          {/* One bright note with a peeled corner, in its own icon tokens
              (--sticky-icon-*), not the muted card fills: at 16px those read
              as a grey smudge. Yellow + dark ink in both themes. */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" strokeLinejoin="round" aria-hidden="true">
            <path d="M4.5 3h15A1.5 1.5 0 0 1 21 4.5V15l-6 6H4.5A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3z" className="sticky-icon-front" />
            <path d="M21 15h-4.5A1.5 1.5 0 0 0 15 16.5V21z" className="sticky-icon-fold" />
            <path d="M7 8.5h10M7 12.5h6.5" className="sticky-icon-ink" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {/* Theme, Settings and Manage users live in the ⋯ menu on every
          screen size: rarely used, and the menu pins one control to the
          top-right corner whatever else the bar is showing. */}
      <div className="toolbar-more" ref={moreRef}>
        <button
          className={`toolbar-more-btn${moreOpen ? ' active' : ''}`}
          onClick={() => setMoreOpen((v) => !v)}
          aria-label="More"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          title="More"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
          {moreNeedsAttention && <span className={`toolbar-more-dot ${wsStatus}`} />}
        </button>
        {moreOpen && (
          <div className="toolbar-more-menu" role="menu">
            {wsStatus && currentPath && (
              <div className="toolbar-more-status more-phone" role="presentation">
                <span className={`ws-status-dot ${wsStatus}`} /> Live collaboration: {statusLabel}
              </div>
            )}
            {onSetBoardActive && (
              <button role="menuitem" className="more-phone" onClick={runMore(() => onSetBoardActive(!boardActive))}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                {boardActive ? 'Close board' : 'Board'}
              </button>
            )}
            {onSetChatsActive && (
              <button role="menuitem" className="more-phone" onClick={runMore(() => onSetChatsActive(!chatsActive))}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <defs><mask id="chats-menu-dots"><rect width="24" height="24" fill="#fff"/><circle cx="6.3" cy="14" r="1.2" fill="#000"/><circle cx="9.6" cy="14" r="1.2" fill="#000"/><circle cx="12.9" cy="14" r="1.2" fill="#000"/></mask></defs>
                  <path d="M9.2 5.6A7 7 0 0 1 21.3 12.9l.9 3.6-3.6-.9a7 7 0 0 1-1.8.9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M9.6 7.4a6.6 6.6 0 1 1-3.4 12.3L2.3 20.8l1.1-3.7A6.6 6.6 0 0 1 9.6 7.4z" fill="currentColor" mask="url(#chats-menu-dots)"/>
                </svg>
                {chatsActive ? 'Close chats' : 'Chats'}
              </button>
            )}
            {onToggleStickies && (
              <button role="menuitem" className="more-phone" onClick={runMore(onToggleStickies)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4.5 3h15A1.5 1.5 0 0 1 21 4.5V15l-6 6H4.5A1.5 1.5 0 0 1 3 19.5v-15A1.5 1.5 0 0 1 4.5 3z" className="sticky-icon-front" />
                  <path d="M21 15h-4.5A1.5 1.5 0 0 0 15 16.5V21z" className="sticky-icon-fold" />
                  <path d="M7 8.5h10M7 12.5h6.5" className="sticky-icon-ink" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
                Stickies
              </button>
            )}
            {currentPath && (onRevealInTree || onRefresh || onRename || onDelete) && <div className="toolbar-more-sep more-phone" />}
            {currentPath && onRevealInTree && (
              <button role="menuitem" className="more-phone" onClick={runMore(onRevealInTree)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
                Show in tree
              </button>
            )}
            {currentPath && onRefresh && (
              <button role="menuitem" className="more-phone" onClick={runMore(handleRefresh)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
                Reload note
              </button>
            )}
            {currentPath && onRename && (
              <button role="menuitem" className="more-phone" onClick={runMore(onRename)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
                Rename
              </button>
            )}
            {currentPath && onDelete && (
              <button role="menuitem" className="danger more-phone" onClick={runMore(onDelete)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>
                Delete
              </button>
            )}
            <div className="toolbar-more-sep more-phone" />
            {onToggleTheme && (
              <button role="menuitem" className="toolbar-more-theme" onClick={runMore(onToggleTheme)}>
                {theme === 'dark' ? (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/></svg>
                ) : (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
                )}
                {theme === 'dark' ? 'Light mode' : 'Dark mode'}
              </button>
            )}
            {/* Same entry, same gate (admin, multi mode) as the sidebar's
                account menu, which on a phone is two taps further away. */}
            {onManageUsers && (
              <button role="menuitem" className="toolbar-more-users" onClick={runMore(onManageUsers)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/></svg>
                Manage users &amp; access
              </button>
            )}
            <button role="menuitem" className="toolbar-more-settings" onClick={runMore(onChangePassword)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
              Settings
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

export default Toolbar;
