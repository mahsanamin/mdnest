package main

import (
	"net/http"

	"github.com/mdnest/mdnest/backend/handlers"
	"github.com/mdnest/mdnest/backend/middleware"
)

// contentRoutes holds everything the note-content routes are built from. It
// exists so the guard on each route (which permission check wraps which
// handler) is set in one function that a test can build with fake stores and
// call over HTTP, instead of being reachable only from main().
type contentRoutes struct {
	auth       func(http.Handler) http.Handler // authMiddleware.Wrap
	perms      *middleware.PermissionChecker   // nil in single mode
	invalidate func(http.Handler) http.Handler // search-cache + tree-changed on writes

	ns          *handlers.NamespaceHandler
	tree        *handlers.TreeHandler
	note        *handlers.NoteHandler
	history     *handlers.HistoryHandler
	attribution *handlers.AttributionHandler // nil without a DB
	comments    *handlers.CommentsHandler    // nil unless live collab is on
	upload      *handlers.UploadHandler
	move        *handlers.MoveHandler
	download    *handlers.DownloadHandler // GET /api/download (issue #114)
	transfer    *handlers.TransferHandler // POST /api/transfer (issue #114)
	search      *handlers.SearchHandler
	tasks       *handlers.TaskHandler // nil unless the task board is on
	team        http.Handler          // nil unless multi mode with Postgres grants
	chat        *handlers.ChatHandler // nil unless chat is on
	sync        *handlers.SyncHandler
	ws          *handlers.WSHandler // nil unless live collab is on
	restart     *handlers.RestartHandler
}

func registerContentRoutes(mux *http.ServeMux, c contentRoutes) {
	auth := c.auth
	perms := c.perms
	invalidateSearch := c.invalidate
	if perms != nil {
		// Attach the checker behind auth, so every handler that lists across a
		// namespace can filter per item (middleware.ReadFilterFor). Without it
		// a multi-mode listing serves nothing.
		auth = func(next http.Handler) http.Handler { return c.auth(perms.Attach(next)) }
	}

	// Apply permission checks in multi mode, passthrough in single mode
	// Restarting the server is a system-wide action: superadmin-only in
	// multi mode. In single mode the one user already owns the server.
	if c.restart != nil {
		if perms != nil {
			mux.Handle("/api/admin/restart", auth(middleware.RequireSuperAdmin(http.HandlerFunc(c.restart.Handle))))
		} else {
			mux.Handle("/api/admin/restart", auth(http.HandlerFunc(c.restart.Handle)))
		}
	}

	if perms != nil {
		mux.Handle("/api/namespaces", auth(http.HandlerFunc(c.ns.ListNamespaces)))
		mux.Handle("/api/tree", auth(perms.RequireNsAccess(http.HandlerFunc(c.tree.GetTree))))
		mux.Handle("/api/note", auth(perms.ReadWriteRouter(invalidateSearch(http.HandlerFunc(c.note.Handle)))))
		// History, attribution and comments all concern ONE note, so each
		// needs read access to that note's path — not just some grant in the
		// namespace (grants can be path-scoped). note/at returns the note's
		// content at any commit, and comments may write the note's ID marker.
		mux.Handle("/api/note/history", auth(perms.RequireRead(http.HandlerFunc(c.history.HandleHistory))))
		mux.Handle("/api/note/at", auth(perms.RequireRead(http.HandlerFunc(c.history.HandleNoteAt))))
		if c.attribution != nil {
			mux.Handle("/api/note/attribution", auth(perms.RequireRead(http.HandlerFunc(c.attribution.HandleAttribution))))
		}
		if c.comments != nil {
			// Commenting is a reader's action: every method needs read on the note.
			mux.Handle("/api/comments", auth(perms.RequireRead(http.HandlerFunc(c.comments.Handle))))
		}
		mux.Handle("/api/folder", auth(perms.RequireWrite(invalidateSearch(http.HandlerFunc(c.upload.HandleFolder)))))
		mux.Handle("/api/upload", auth(perms.RequireWrite(invalidateSearch(http.HandlerFunc(c.upload.HandleUpload)))))
		mux.Handle("/api/move", auth(perms.RequireMove(invalidateSearch(http.HandlerFunc(c.move.HandleMove)))))
		// Path-scoped read, not RequireNsAccess: a grant on /Shared must not be
		// able to zip /Private. Grants cover everything below their path, and
		// the zip walk leaves out links, so the folder's check covers its files.
		mux.Handle("/api/download", auth(perms.RequireRead(http.HandlerFunc(c.download.HandleDownload))))
		// Two namespaces in the body: the handler checks both sides itself
		// (the checks are its required constructor arguments).
		mux.Handle("/api/transfer", auth(http.HandlerFunc(c.transfer.HandleTransfer)))
		// Search spans the namespace: it filters each hit by read access.
		mux.Handle("/api/search", auth(perms.RequireNsAccess(http.HandlerFunc(c.search.HandleSearch))))
		// Task aggregation: GET reads notes, PATCH rewrites a task line in a note,
		// so route by method (read vs write) and invalidate the search cache on
		// mutation just like /api/note.
		if c.tasks != nil {
			mux.Handle("/api/tasks", auth(perms.ReadWriteRouter(invalidateSearch(http.HandlerFunc(c.tasks.HandleTasks)))))
			// The column layout belongs to the whole namespace: reading it
			// follows ?path= like the board view, changing it needs write on
			// the namespace whatever ?path= names.
			mux.Handle("/api/board", auth(perms.ReadWriteRouter(requireNamespaceWriteToChange(perms, http.HandlerFunc(c.tasks.HandleBoard)))))
			// Cross-namespace view: aggregates the caller's accessible namespaces.
			// Auth-only here — the handler self-filters via the namespace filter
			// and then each task by its note (ReadFilterFor), so it must not be
			// wrapped in the single-namespace RequireNsAccess.
			mux.Handle("/api/tasks/all", auth(http.HandlerFunc(c.tasks.HandleGlobalTasks)))
		}
		// Namespace members for the task assignee picker and the private chat
		// member picker. Read-access gated: anyone who can see the namespace
		// may list who else is on it.
		if c.team != nil {
			mux.Handle("/api/namespace/users", auth(perms.RequireNsAccess(c.team)))
		}
		if c.chat != nil {
			// Read a chat = read the note; post or convert = write it.
			mux.Handle("/api/chat", auth(perms.ReadWriteRouter(invalidateSearch(http.HandlerFunc(c.chat.Handle)))))
			mux.Handle("/api/chat/convert", auth(perms.RequireWrite(invalidateSearch(http.HandlerFunc(c.chat.HandleConvert)))))
			// A status is presence, not content: same right as posting, and
			// nothing is written, so no search invalidation.
			mux.Handle("/api/chat/status", auth(perms.RequireWrite(http.HandlerFunc(c.chat.HandleStatus))))
			mux.Handle("/api/chat/agents", auth(perms.RequireWrite(http.HandlerFunc(c.chat.HandleAgents))))
			// Cross-namespace: self-filters, like /api/tasks/all.
			mux.Handle("/api/chats", auth(http.HandlerFunc(c.chat.HandleList)))
			// The chat image library: any access to the namespace may list it,
			// filtered to the images the user may read; /api/files checks again.
			mux.Handle("/api/chat/gifs", auth(perms.RequireNsAccess(http.HandlerFunc(c.chat.HandleGifs))))
			mux.HandleFunc(handlers.BuiltinGifRoute, handlers.HandleBuiltinGif)
			// Private chat members (issue #127). Seeing the list is a reader's
			// right, changing it a writer's; the checker already refuses a
			// non-member of a private chat both.
			if c.chat.MembersEnabled() {
				mux.Handle("/api/chat/members", auth(perms.ReadWriteRouter(http.HandlerFunc(c.chat.HandleMembers))))
			}
		}
		mux.Handle("/api/files/", auth(http.HandlerFunc(c.upload.HandleServeFile))) // files endpoint extracts ns from URL, handled differently
	} else {
		mux.Handle("/api/namespaces", auth(http.HandlerFunc(c.ns.ListNamespaces)))
		mux.Handle("/api/tree", auth(http.HandlerFunc(c.tree.GetTree)))
		mux.Handle("/api/note", auth(invalidateSearch(http.HandlerFunc(c.note.Handle))))
		// History endpoints work in single mode too — git-sync runs
		// orthogonally to AUTH_MODE.
		mux.Handle("/api/note/history", auth(http.HandlerFunc(c.history.HandleHistory)))
		mux.Handle("/api/note/at", auth(http.HandlerFunc(c.history.HandleNoteAt)))
		// /api/comments intentionally unregistered in single mode.
		mux.Handle("/api/folder", auth(invalidateSearch(http.HandlerFunc(c.upload.HandleFolder))))
		mux.Handle("/api/upload", auth(invalidateSearch(http.HandlerFunc(c.upload.HandleUpload))))
		mux.Handle("/api/move", auth(invalidateSearch(http.HandlerFunc(c.move.HandleMove))))
		mux.Handle("/api/download", auth(http.HandlerFunc(c.download.HandleDownload)))
		mux.Handle("/api/transfer", auth(http.HandlerFunc(c.transfer.HandleTransfer)))
		mux.Handle("/api/search", auth(http.HandlerFunc(c.search.HandleSearch)))
		if c.tasks != nil {
			mux.Handle("/api/tasks", auth(invalidateSearch(http.HandlerFunc(c.tasks.HandleTasks))))
			mux.Handle("/api/board", auth(http.HandlerFunc(c.tasks.HandleBoard)))
			// Single mode: one user owns every namespace, so the global view
			// aggregates them all (nil namespace filter).
			mux.Handle("/api/tasks/all", auth(http.HandlerFunc(c.tasks.HandleGlobalTasks)))
		}
		if c.chat != nil {
			mux.Handle("/api/chat", auth(invalidateSearch(http.HandlerFunc(c.chat.Handle))))
			mux.Handle("/api/chat/convert", auth(invalidateSearch(http.HandlerFunc(c.chat.HandleConvert))))
			mux.Handle("/api/chat/status", auth(http.HandlerFunc(c.chat.HandleStatus)))
			mux.Handle("/api/chat/agents", auth(http.HandlerFunc(c.chat.HandleAgents)))
			mux.Handle("/api/chats", auth(http.HandlerFunc(c.chat.HandleList)))
			mux.Handle("/api/chat/gifs", auth(http.HandlerFunc(c.chat.HandleGifs)))
			mux.HandleFunc(handlers.BuiltinGifRoute, handlers.HandleBuiltinGif)
		}
		mux.Handle("/api/files/", auth(http.HandlerFunc(c.upload.HandleServeFile)))
	}

	// Git sync endpoints (admin-only in multi mode, always allowed in single)
	if perms != nil {
		mux.Handle("/api/admin/sync", auth(middleware.RequireAdmin(http.HandlerFunc(c.sync.HandleSync))))
		// Status of one namespace's git mirror: only for users with access to
		// that namespace (the remote URL is redacted in the handler).
		mux.Handle("/api/admin/sync-status", auth(perms.RequireNsAccess(http.HandlerFunc(c.sync.HandleSyncStatus))))
	} else {
		mux.Handle("/api/admin/sync", auth(http.HandlerFunc(c.sync.HandleSync)))
		mux.Handle("/api/admin/sync-status", auth(http.HandlerFunc(c.sync.HandleSyncStatus)))
	}

	// WebSocket route for live collaboration (no auth middleware — JWT verified in handler)
	if c.ws != nil {
		mux.HandleFunc("/api/ws", c.ws.HandleWS)
	}
}

// requireNamespaceWriteToChange lets reads through and requires write on the
// namespace root for anything else. For resources stored once per namespace
// (the task board's columns), where the ?path= a request names says nothing
// about what it changes.
func requireNamespaceWriteToChange(perms *middleware.PermissionChecker, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if ns := r.URL.Query().Get("ns"); ns != "" && !perms.CheckWrite(r, ns, "/") {
				middleware.DenyJSON(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
