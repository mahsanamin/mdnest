package storage

// System namespaces are reserved, hidden storage partitions that hold
// app-managed data rather than user notes. Their names start with "." so they
// are excluded from every namespace listing (see ListNamespaces in each
// backend) and from the grant / admin pickers — they are never surfaced as a
// user workspace. Because the writer's hydrate() walks only the user-visible
// namespaces, it must hydrate these explicitly so stateless (app-role) replicas
// can read them from the coherence tier.
const (
	// SystemNamespaceMarpThemes stores the centralized Marp theme catalog
	// (one <name>.css per theme). Managed by superadmins; readable by all.
	SystemNamespaceMarpThemes = ".marp-themes"
)

// SystemNamespaces is the full set of reserved namespaces the writer hydrates
// into the coherence tier in addition to the user-visible ones.
var SystemNamespaces = []string{SystemNamespaceMarpThemes}
