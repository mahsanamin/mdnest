package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/mdnest/mdnest/backend/relpath"
	"github.com/mdnest/mdnest/backend/storage"
	"github.com/mdnest/mdnest/backend/store"
)

// PermissionChecker validates user access to namespaces and paths.
// Nil in single-user mode (all access granted).
type PermissionChecker struct {
	grantStore   store.GrantStore
	nsAdminStore store.NamespaceAdminStore
	groupStore   store.GroupStore      // role-based "Groups" access; nil disables it
	links        storage.LinkResolver  // nil: the storage has no symlinks (app tier)
	chatMembers  store.ChatMemberStore // private chats (issue #127); nil disables them
}

// SetChatMembers turns on private chats: a note with a member list is readable
// and writable only by its members, on top of the usual grant check. It
// applies to namespace admins too. The point of a private chat is that the
// people in a workspace cannot read it unless invited, and an admin is one of
// those people.
func (pc *PermissionChecker) SetChatMembers(s store.ChatMemberStore) {
	pc.chatMembers = s
}

// chatMemberOK reports whether uc may touch the note at path as far as chat
// membership is concerned: true for anything that is not a private chat, and
// for a member of one. A lookup error refuses, so a database hiccup never
// opens a private chat.
func (pc *PermissionChecker) chatMemberOK(uc *UserContext, namespace, path string) bool {
	if pc.chatMembers == nil {
		return true
	}
	ids, err := pc.chatMembers.Members(namespace, "/"+strings.Trim(path, "/"))
	if err != nil {
		return false
	}
	return len(ids) == 0 || containsID(ids, uc.ID)
}

func containsID(ids []int, id int) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}

// chatFilter loads the namespace's private chats once and returns a predicate
// that is false for a private chat uc is not on. For listings, which check
// every path in a namespace. ok is false when the list cannot be loaded; the
// caller must then refuse everything.
func (pc *PermissionChecker) chatFilter(uc *UserContext, namespace string) (func(canonical string) bool, bool) {
	if pc.chatMembers == nil || uc == nil {
		return func(string) bool { return true }, true
	}
	restricted, err := pc.chatMembers.Restricted(namespace)
	if err != nil {
		return nil, false
	}
	if len(restricted) == 0 {
		return func(string) bool { return true }, true
	}
	return func(p string) bool {
		ids, private := restricted[p]
		return !private || containsID(ids, uc.ID)
	}, true
}

// PrivateChatFilter returns a predicate that is false for a private chat the
// user is not a member of, for handlers that filter a listing on their own
// (the tree). Fails closed: if the member lists cannot be loaded, nothing is
// visible.
func (pc *PermissionChecker) PrivateChatFilter(r *http.Request, namespace string) func(relPath string) bool {
	f, ok := pc.chatFilter(UserFromContext(r.Context()), namespace)
	if !ok {
		return func(string) bool { return false }
	}
	return func(relPath string) bool {
		p, ok := canonicalPath(relPath)
		return ok && f(p)
	}
}

// noForeignChatsUnder reports whether the folder at path holds no private chat
// that uc is not a member of. Used for operations that act on a whole folder
// (delete, move, copy to another namespace), where checking the folder alone
// would let a non-member delete, carry off or copy someone else's chat.
func (pc *PermissionChecker) noForeignChatsUnder(uc *UserContext, namespace, path string) bool {
	if pc.chatMembers == nil || uc == nil {
		return true
	}
	restricted, err := pc.chatMembers.Restricted(namespace)
	if err != nil {
		return false
	}
	root := "/" + strings.Trim(path, "/")
	for p, ids := range restricted {
		under := root == "/" || p == root || strings.HasPrefix(p, root+"/")
		if under && !containsID(ids, uc.ID) {
			return false
		}
	}
	return true
}

// SetStorage tells the checker which storage the paths it authorises live on,
// so a path that reaches another file through a symbolic link is authorised
// for that file too (see storage.LinkResolver). A storage without links (the
// app tier's working set) leaves every path as named.
func (pc *PermissionChecker) SetStorage(stg storage.Storage) {
	if lr, ok := stg.(storage.LinkResolver); ok {
		pc.links = lr
	}
}

// resolve returns the canonical ("/a/b") path p really reaches once symbolic
// links are followed. ok is false when that cannot be determined (a dangling
// link, a link out of the namespace, an I/O error): callers refuse.
func (pc *PermissionChecker) resolve(ctx context.Context, ns, p string) (string, bool) {
	rel := strings.TrimPrefix(p, "/")
	if pc.links == nil || rel == "" {
		return p, true
	}
	real, err := pc.links.ResolveLinks(ctx, ns, rel)
	if err != nil {
		return "", false
	}
	// A link is held to the request-path rules too: one that reaches .git or
	// .mdnest is refused, whatever the user's grant.
	if relpath.HasReservedSegment(real) {
		return "", false
	}
	return "/" + real, true
}

// NewPermissionChecker creates a new PermissionChecker. nsAdminStore is
// consulted for role="admin" requests to decide whether the namespace is
// in the user's admin scope; superadmins bypass it entirely. groupStore adds
// role-based ("Groups") access on top of per-user grants; nil disables it.
func NewPermissionChecker(grantStore store.GrantStore, nsAdminStore store.NamespaceAdminStore, groupStore store.GroupStore) *PermissionChecker {
	return &PermissionChecker{grantStore: grantStore, nsAdminStore: nsAdminStore, groupStore: groupStore}
}

// hasAdminScope returns true if the user's role grants admin-level
// *data* access to the given namespace. Only a namespace-scoped admin
// (role "admin" with a row in namespace_admins) qualifies. Superadmins are
// deliberately excluded: they administer every namespace (users, grants,
// create/delete) but have no implicit read/write access to note content —
// they must self-grant like anyone else. Used as the short-circuit before
// falling through to grant lookups.
func (pc *PermissionChecker) hasAdminScope(uc *UserContext, namespace string) bool {
	if uc.Role == "admin" && pc.nsAdminStore != nil && namespace != "" {
		ok, err := pc.nsAdminStore.IsAdminOf(uc.ID, namespace)
		return err == nil && ok
	}
	return false
}

// HasAdminScope is hasAdminScope for handlers that filter on their own (the
// tree): a namespace-scoped admin of THIS namespace sees all of it.
func (pc *PermissionChecker) HasAdminScope(uc *UserContext, namespace string) bool {
	return pc.hasAdminScope(uc, namespace)
}

// CheckRead returns true if the user can read the given namespace/path.
// Admins always have access. In single-user mode (no user context), access is granted.
func (pc *PermissionChecker) CheckRead(r *http.Request, namespace, path string) bool {
	return pc.check(r, namespace, path, "read")
}

// CheckWrite returns true if the user can write to the given namespace/path.
func (pc *PermissionChecker) CheckWrite(r *http.Request, namespace, path string) bool {
	return pc.check(r, namespace, path, "write")
}

// CheckReadTree is CheckRead for an operation that carries a whole folder off
// (a copy to another namespace): it also refuses when the folder holds a
// private chat the user is not a member of.
func (pc *PermissionChecker) CheckReadTree(r *http.Request, namespace, path string) bool {
	return pc.CheckRead(r, namespace, path) && pc.noForeignChatsUnder(UserFromContext(r.Context()), namespace, path)
}

// CheckWriteTree is CheckWrite for an operation on a whole folder (delete,
// move): it also refuses when the folder holds a private chat the user is not
// a member of. For a single note it is the same as CheckWrite.
func (pc *PermissionChecker) CheckWriteTree(r *http.Request, namespace, path string) bool {
	return pc.CheckWrite(r, namespace, path) && pc.noForeignChatsUnder(UserFromContext(r.Context()), namespace, path)
}

func (pc *PermissionChecker) check(r *http.Request, namespace, path, permission string) bool {
	uc := UserFromContext(r.Context())
	if uc == nil {
		return true // single-user mode
	}
	// Before the admin shortcut: a private chat binds namespace admins too.
	if !pc.chatMemberOK(uc, namespace, path) {
		return false
	}
	if pc.hasAdminScope(uc, namespace) {
		return true
	}
	if !pc.granted(uc, namespace, path, permission) {
		return false
	}
	// A symbolic link is authorised for the file it reaches as well as for its
	// own name: Shared/link.md -> Private/p.md must not hand a /Shared grant
	// the /Private file. A link that stays inside what the user may access
	// keeps working.
	real, ok := pc.resolve(r.Context(), namespace, path)
	if !ok {
		return false
	}
	if real != "/"+strings.TrimPrefix(path, "/") {
		return pc.chatMemberOK(uc, namespace, real) && pc.granted(uc, namespace, real, permission)
	}
	return true
}

func (pc *PermissionChecker) granted(uc *UserContext, namespace, path, permission string) bool {
	if pc.grantStore.CheckAccess(uc.ID, namespace, path, permission) {
		return true
	}
	// Role-based access: any group the user belongs to (directly or via an
	// OIDC group ID) may grant the permission.
	if pc.groupStore != nil {
		return pc.groupStore.CheckGroupAccess(uc.ID, uc.Groups, namespace, path, permission)
	}
	return false
}

// ReadFilter returns, for one request and namespace, a predicate telling
// whether the user may read a namespace-relative path. It is CheckRead for
// listings that span a namespace (search, the global task view, the chat gif
// library): the user's grants and group grants are loaded ONCE and matched
// with the same rule the grant stores use (store.GrantsAllow /
// GroupGrantsAllow), instead of two queries per file. Seeing a namespace is
// not the same as reading every note in it — grants can be path-scoped.
func (pc *PermissionChecker) ReadFilter(r *http.Request, namespace string) func(relPath string) bool {
	uc := UserFromContext(r.Context())
	if uc == nil {
		return func(string) bool { return true } // single-user mode, as check()
	}
	chatOK, ok := pc.chatFilter(uc, namespace)
	if !ok {
		return func(string) bool { return false }
	}
	if pc.hasAdminScope(uc, namespace) {
		return func(relPath string) bool {
			p, ok := canonicalPath(relPath)
			return ok && chatOK(p)
		}
	}
	var grants []store.Grant
	if all, err := pc.grantStore.GetGrantsForUser(uc.ID); err == nil {
		grants = all
	}
	var groupGrants []store.GroupGrant
	if pc.groupStore != nil {
		if gg, err := pc.groupStore.MemberGroupGrants(uc.ID, uc.Groups, namespace); err == nil {
			groupGrants = gg
		}
	}
	allowed := func(p string) bool {
		return store.GrantsAllow(grants, namespace, p, "read") || store.GroupGrantsAllow(groupGrants, p, "read")
	}
	// A reader of the whole namespace may read every file in it. Storage
	// refuses a link that leaves the namespace or reaches .git, so nothing
	// needs resolving here; a link into .mdnest can only show this reader
	// comment data of notes they can already read.
	if allowed("/") {
		return func(relPath string) bool { p, ok := canonicalPath(relPath); return ok && chatOK(p) }
	}
	ctx := r.Context()
	return func(relPath string) bool {
		p, ok := canonicalPath(relPath)
		if !ok || !allowed(p) || !chatOK(p) {
			return false
		}
		real, ok := pc.resolve(ctx, namespace, p)
		return ok && (real == p || (allowed(real) && chatOK(real)))
	}
}

type checkerKey struct{}

// Attach makes the checker available to the handlers behind it, for the
// listings that filter per item (see ReadFilterFor).
func (pc *PermissionChecker) Attach(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), checkerKey{}, pc)))
	})
}

// CheckerFrom returns the checker attached to the request, or nil.
func CheckerFrom(ctx context.Context) *PermissionChecker {
	pc, _ := ctx.Value(checkerKey{}).(*PermissionChecker)
	return pc
}

// ReadFilterFor is the per-item read filter for a handler that lists across a
// namespace. It fails closed: a request that carries a user (multi mode) but
// reached the handler without a checker attached gets a filter that allows
// nothing, so forgetting to wire Attach serves an empty list rather than every
// note. Single-user mode (no user, no checker) reads everything.
func ReadFilterFor(r *http.Request, namespace string) func(relPath string) bool {
	if pc := CheckerFrom(r.Context()); pc != nil {
		return pc.ReadFilter(r, namespace)
	}
	if UserFromContext(r.Context()) != nil {
		return func(string) bool { return false }
	}
	return func(string) bool { return true }
}

// FilterNamespaces returns only the namespaces the user has (data) access to.
// Single-user mode sees everything. Superadmins are filtered by their explicit
// grants like everyone else — administering a namespace no longer implies data
// access to it. Namespace-admins see the union of (admin namespaces, granted
// namespaces); collaborators see only their granted namespaces.
func (pc *PermissionChecker) FilterNamespaces(r *http.Request, namespaces []string) []string {
	uc := UserFromContext(r.Context())
	if uc == nil {
		return namespaces
	}

	accessSet := make(map[string]bool)
	if accessible, err := pc.grantStore.GetAccessibleNamespaces(uc.ID); err == nil {
		for _, ns := range accessible {
			accessSet[ns] = true
		}
	}
	if pc.groupStore != nil {
		if accessible, err := pc.groupStore.GetAccessibleNamespacesForGroups(uc.ID, uc.Groups); err == nil {
			for _, ns := range accessible {
				accessSet[ns] = true
			}
		}
	}
	if uc.Role == "admin" && pc.nsAdminStore != nil {
		if adminOf, err := pc.nsAdminStore.ListByUser(uc.ID); err == nil {
			for _, ns := range adminOf {
				accessSet[ns] = true
			}
		}
	}

	var filtered []string
	for _, ns := range namespaces {
		if accessSet[ns] {
			filtered = append(filtered, ns)
		}
	}
	return filtered
}

// FilterManageableNamespaces returns the namespaces the user may *administer*
// (manage users/grants, create/delete), independent of whether they can access
// the namespace's contents. Single-user mode and superadmins get the full
// list; namespace-admins get their scoped namespaces; collaborators get none.
// This is the management-plane counterpart to FilterNamespaces: the two diverge
// for superadmins, who administer every namespace but have no implicit data
// access to any of them.
func (pc *PermissionChecker) FilterManageableNamespaces(r *http.Request, namespaces []string) []string {
	uc := UserFromContext(r.Context())
	if uc == nil || uc.Role == "superadmin" {
		return namespaces
	}
	if uc.Role != "admin" || pc.nsAdminStore == nil {
		return []string{}
	}
	adminSet := make(map[string]bool)
	if adminOf, err := pc.nsAdminStore.ListByUser(uc.ID); err == nil {
		for _, ns := range adminOf {
			adminSet[ns] = true
		}
	}
	var filtered []string
	for _, ns := range namespaces {
		if adminSet[ns] {
			filtered = append(filtered, ns)
		}
	}
	return filtered
}

// DenyJSON writes a 403 JSON error response.
func DenyJSON(w http.ResponseWriter) {
	http.Error(w, `{"error":"access denied"}`, http.StatusForbidden)
}

// canonicalPath turns a namespace-relative query path into the absolute form
// grants are matched against, cleaned with the same rule the handlers apply
// (relpath.Clean). Checking the raw string instead let "Shared/../Private/x"
// pass a /Shared grant while the handler acted on Private/x. An empty path
// means the namespace root. ok is false when the path cannot be cleaned
// (absolute, or escapes the namespace); callers must refuse the request then,
// never fall back to the raw value.
func canonicalPath(raw string) (string, bool) {
	if raw == "" {
		return "/", true
	}
	cleaned, ok := relpath.Clean(raw)
	if !ok {
		return "", false
	}
	return "/" + cleaned, true
}

func invalidPathJSON(w http.ResponseWriter) {
	http.Error(w, `{"error":"invalid path"}`, http.StatusBadRequest)
}

// RequireRead wraps a handler and checks read access for the namespace/path
// from query parameters. Admins and single-mode users pass through.
func (pc *PermissionChecker) RequireRead(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		if ns != "" {
			path, ok := canonicalPath(r.URL.Query().Get("path"))
			if !ok {
				invalidPathJSON(w)
				return
			}
			if !pc.CheckRead(r, ns, path) {
				DenyJSON(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// RequireWrite wraps a handler and checks write access for the namespace/path
// from query parameters.
func (pc *PermissionChecker) RequireWrite(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		if ns != "" {
			path, ok := canonicalPath(r.URL.Query().Get("path"))
			if !ok {
				invalidPathJSON(w)
				return
			}
			if !pc.CheckWrite(r, ns, path) {
				DenyJSON(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// RequireNsAccess wraps a handler and checks that the user has any grant
// at all in the namespace. Used for tree and search endpoints where the user
// needs at least some access to the namespace.
func (pc *PermissionChecker) RequireNsAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		if ns == "" {
			next.ServeHTTP(w, r)
			return
		}
		uc := UserFromContext(r.Context())
		if uc == nil {
			next.ServeHTTP(w, r)
			return
		}
		if pc.hasAdminScope(uc, ns) {
			next.ServeHTTP(w, r)
			return
		}
		// Check if user has any grant in this namespace
		accessible, err := pc.grantStore.GetAccessibleNamespaces(uc.ID)
		if err != nil {
			DenyJSON(w)
			return
		}
		for _, a := range accessible {
			if a == ns {
				next.ServeHTTP(w, r)
				return
			}
		}
		// ...or any access-group grant in this namespace.
		if pc.groupStore != nil {
			if gns, err := pc.groupStore.GetAccessibleNamespacesForGroups(uc.ID, uc.Groups); err == nil {
				for _, a := range gns {
					if a == ns {
						next.ServeHTTP(w, r)
						return
					}
				}
			}
		}
		DenyJSON(w)
	})
}

// CheckMoveAccess checks write permission on both source and destination paths.
func (pc *PermissionChecker) CheckMoveAccess(r *http.Request) bool {
	ns := r.URL.Query().Get("ns")
	from := r.URL.Query().Get("from")
	to := r.URL.Query().Get("to")
	if ns == "" {
		return true
	}
	from, okFrom := canonicalPath(from)
	to, okTo := canonicalPath(to)
	if !okFrom || !okTo {
		return false
	}
	return pc.CheckWriteTree(r, ns, from) && pc.CheckWrite(r, ns, to)
}

// RequireMove wraps a handler and checks write access on both from and to paths.
func (pc *PermissionChecker) RequireMove(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !pc.CheckMoveAccess(r) {
			DenyJSON(w)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ReadWriteRouter wraps a handler and applies read check for GET/HEAD,
// write check for POST/PUT/PATCH, and the folder-aware write check for
// DELETE. Used for the /api/note endpoint.
func (pc *PermissionChecker) ReadWriteRouter(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ns := r.URL.Query().Get("ns")
		if ns == "" {
			next.ServeHTTP(w, r)
			return
		}
		path, ok := canonicalPath(r.URL.Query().Get("path"))
		if !ok {
			invalidPathJSON(w)
			return
		}
		switch r.Method {
		case "GET", "HEAD":
			if !pc.CheckRead(r, ns, path) {
				DenyJSON(w)
				return
			}
		case "DELETE":
			// A folder delete removes every note under it, so it also needs
			// membership of any private chat in there.
			if !pc.CheckWriteTree(r, ns, path) {
				DenyJSON(w)
				return
			}
		default:
			if !pc.CheckWrite(r, ns, path) {
				DenyJSON(w)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
