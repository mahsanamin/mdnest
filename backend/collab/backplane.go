package collab

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
)

// Backplane fans hub events out to peer instances so a horizontally-scaled
// deployment behaves as one logical hub (opt-in). The zero-value default is
// nopBackplane, which keeps the historical single-instance behavior: publishes
// go nowhere and no peer events are ever delivered.

// wire* are the envelope types exchanged between hub instances.
const (
	wireNote     = "note"     // fan out to conns on a specific note (Key)
	wireNsPrefix = "nsprefix" // fan out to conns whose note is under a namespace (Ns)
	wireAll      = "all"      // fan out to every conn
	wirePresence = "presence" // advertise an instance's local user-set for a note
)

// wireMsg is the envelope exchanged between hub instances over a Backplane.
// It is internal to the collab package; peers exchange it as JSON.
type wireMsg struct {
	Origin  string          `json:"o"`            // instance id of the publisher
	Type    string          `json:"t"`            // one of the wire* constants
	Key     string          `json:"k,omitempty"`  // noteKey (wireNote / wirePresence)
	Ns      string          `json:"ns,omitempty"` // namespace (wireNsPrefix)
	Payload json.RawMessage `json:"p,omitempty"`  // marshaled OutgoingMessage (note/nsprefix/all)
	Users   []UserInfo      `json:"u,omitempty"`  // Origin's local user-set for Key (wirePresence)
}

// Backplane is the transport hubs use to share events across instances.
type Backplane interface {
	// Publish sends an envelope to all peer instances. Implementations may
	// echo the message back to the sender; the hub filters its own Origin.
	Publish(m wireMsg)
	// Start begins delivering peer envelopes to deliver until Close is called.
	Start(deliver func(wireMsg))
	// Close releases any resources held by the backplane.
	Close() error
}

// nopBackplane is the default single-instance backplane: it drops publishes
// and never delivers anything. With it attached the hub behaves exactly as it
// did before the backplane existed.
type nopBackplane struct{}

func (nopBackplane) Publish(wireMsg)     {}
func (nopBackplane) Start(func(wireMsg)) {}
func (nopBackplane) Close() error        { return nil }

// newInstanceID returns a random hex id identifying this hub process, used to
// suppress self-echo of published messages.
func newInstanceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failure is exceptionally rare; a fixed id still works
		// for a single process (it only needs to be unique across peers).
		return "instance-fallback"
	}
	return hex.EncodeToString(b[:])
}
