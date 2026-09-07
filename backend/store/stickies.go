package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
)

// Stickies are a personal scratch board — a handful of short notes a user keeps
// beside their workspace. They are NOT notes: they never appear in a namespace,
// never reach a git remote, and are not shared with anyone. That is the whole
// point of the feature, and it is the storage location that delivers it, not
// encryption: everything here lives in the secrets volume, which the git-sync
// sidecar (which walks /data/notes/*/) cannot see.
//
// The board is persisted whole, not per card. The API replaces the array on
// every change, so a row-per-card schema would buy nothing but a diffing
// problem and a concurrency question the feature does not have.

// StickyItem is one checkable line on a card. A sticky is usually a small
// list, not a single yes/no thing, so "done" lives here rather than on the
// card — a card-level flag forces "buy milk, call bank, post form" to be three
// separate notes or one note you can only tick when all of it is finished.
type StickyItem struct {
	ID   string `json:"id"`
	Text string `json:"text"`
	Done bool   `json:"done"`
}

// Sticky is one card: an optional title, some free text, and an optional
// checklist. All three are optional so the same card covers a scribbled note,
// a titled note, and a to-do list without three different kinds of card.
//
// X and Y are the card's position on the full-screen corkboard, in board
// pixels. They are POINTERS so that "never placed" is distinguishable from
// "placed at the top-left corner" — with plain float64 a brand new card and a
// card deliberately dragged to 0,0 would be identical, and the client lays out
// unplaced cards on a grid rather than stacking them all in one corner.
// A card only gains a position when it is dragged; the drawer never sets one.
type Sticky struct {
	ID        string       `json:"id"`
	Title     string       `json:"title"`
	Body      string       `json:"body"`
	Items     []StickyItem `json:"items"`
	Color     string       `json:"color"`
	X         *float64     `json:"x,omitempty"`
	Y         *float64     `json:"y,omitempty"`
	W         *float64     `json:"w,omitempty"`
	CreatedAt int64        `json:"created_at"`
	UpdatedAt int64        `json:"updated_at"`
}

// Limits, enforced by ValidateBoard on every write. They exist because the
// endpoint is writable by any authenticated user: without them a board is an
// unbounded per-user blob store, the same reasoning that gave preferences a
// key allowlist.
const (
	MaxStickies     = 200  // cards per board
	MaxStickyTitle  = 200  // bytes in one card title
	MaxStickyBody   = 4096 // bytes in one card
	MaxStickyItems  = 50   // checklist lines on one card
	MaxStickyItemLn = 500  // bytes in one checklist line
	MaxStickyID     = 64   // bytes in one card id
	MaxStickyBoard  = 262144

	// Width bounds for a resized card. Only width is user-settable: height is
	// driven by the content (the text areas grow as you type), so a stored
	// height would either clip a card or leave a gap under it the moment the
	// text changed.
	MinStickyWidth = 150
	MaxStickyWidth = 600

	// MaxStickyCoord bounds a card's position on the corkboard. The board
	// scrolls to fit its content, so without a ceiling one card dragged to
	// x=1e9 would stretch the scrollable area past everything else and make
	// the rest of the board unreachable. Generous enough for any real board.
	MaxStickyCoord = 20000
)

// StickyColors is the palette a card may claim. The frontend only ever sends
// one of these; the server checks anyway, because the value ends up in a CSS
// class name and an open enum there is an injection surface for free.
var StickyColors = map[string]bool{
	"yellow": true,
	"pink":   true,
	"blue":   true,
	"green":  true,
	"grey":   true,
}

// ErrStickyBoard is the class of every validation failure below. Callers turn
// it into a 400; anything else is a 500.
var ErrStickyBoard = errors.New("invalid sticky board")

// ValidateBoard checks a board against the limits and normalises what it can.
// It returns a wrapped ErrStickyBoard naming the specific problem — the client
// shows that string, and "too many stickies" is actionable where "bad request"
// is not.
//
// Normalisation is deliberately narrow: an empty colour becomes the default
// rather than failing, because that is what an older client or a hand-written
// PUT would send. A *wrong* colour still fails — quietly substituting a value
// the caller did not ask for is the behaviour the preferences handler
// explicitly rejected.
func ValidateBoard(cards []Sticky) ([]Sticky, error) {
	if len(cards) > MaxStickies {
		return nil, wrapSticky("too many stickies (max %d)", MaxStickies)
	}
	seen := make(map[string]bool, len(cards))
	out := make([]Sticky, 0, len(cards))
	for _, c := range cards {
		if c.ID == "" {
			return nil, wrapSticky("sticky is missing an id")
		}
		if len(c.ID) > MaxStickyID {
			return nil, wrapSticky("sticky id too long (max %d bytes)", MaxStickyID)
		}
		if seen[c.ID] {
			return nil, wrapSticky("duplicate sticky id")
		}
		seen[c.ID] = true
		if len(c.Title) > MaxStickyTitle {
			return nil, wrapSticky("title too long (max %d bytes)", MaxStickyTitle)
		}
		if len(c.Body) > MaxStickyBody {
			return nil, wrapSticky("sticky too large (max %d bytes)", MaxStickyBody)
		}
		items, err := validItems(c.Items)
		if err != nil {
			return nil, err
		}
		c.Items = items
		if c.Color == "" {
			c.Color = "yellow"
		}
		if !StickyColors[c.Color] {
			return nil, wrapSticky("invalid colour")
		}
		if err := validCoord(c.X); err != nil {
			return nil, err
		}
		if err := validCoord(c.Y); err != nil {
			return nil, err
		}
		if err := validWidth(c.W); err != nil {
			return nil, err
		}
		out = append(out, c)
	}

	// Marshal-size check last: the per-card caps bound this already, but the
	// stored form is what has to fit, and that is the only honest way to
	// measure it.
	data, err := json.Marshal(out)
	if err != nil {
		return nil, err
	}
	if len(data) > MaxStickyBoard {
		return nil, wrapSticky("board too large (max %d bytes)", MaxStickyBoard)
	}
	return out, nil
}

// validItems checks a card's checklist and normalises it to a non-nil slice.
//
// Non-nil matters on the wire: a nil slice marshals to `null`, and the client
// maps over it, so one card with no checklist would break the render of the
// whole board. Empty array is the correct empty value here.
func validItems(items []StickyItem) ([]StickyItem, error) {
	if len(items) > MaxStickyItems {
		return nil, wrapSticky("too many checklist items (max %d)", MaxStickyItems)
	}
	out := make([]StickyItem, 0, len(items))
	seen := make(map[string]bool, len(items))
	for _, it := range items {
		if it.ID == "" {
			return nil, wrapSticky("checklist item is missing an id")
		}
		if len(it.ID) > MaxStickyID {
			return nil, wrapSticky("checklist item id too long (max %d bytes)", MaxStickyID)
		}
		if seen[it.ID] {
			return nil, wrapSticky("duplicate checklist item id")
		}
		seen[it.ID] = true
		if len(it.Text) > MaxStickyItemLn {
			return nil, wrapSticky("checklist item too long (max %d bytes)", MaxStickyItemLn)
		}
		out = append(out, it)
	}
	return out, nil
}

// validCoord bounds one axis of a card's board position. nil is fine — that is
// a card that has never been dragged. NaN and Inf are rejected explicitly:
// they survive a JSON round trip through a float64, and either one poisons the
// board-size arithmetic on the client into NaN, which collapses the whole
// corkboard rather than misplacing one card.
func validCoord(v *float64) error {
	if v == nil {
		return nil
	}
	if math.IsNaN(*v) || math.IsInf(*v, 0) {
		return wrapSticky("invalid position")
	}
	if *v < 0 || *v > MaxStickyCoord {
		return wrapSticky("position out of bounds (0-%d)", MaxStickyCoord)
	}
	return nil
}

// validWidth bounds a resized card. nil is "never resized" — the client uses
// its default width — which is the same nil-means-untouched convention X and Y
// use, and for the same reason: a stored 0 would be a card resized to nothing.
func validWidth(v *float64) error {
	if v == nil {
		return nil
	}
	if math.IsNaN(*v) || math.IsInf(*v, 0) {
		return wrapSticky("invalid width")
	}
	if *v < MinStickyWidth || *v > MaxStickyWidth {
		return wrapSticky("width out of bounds (%d-%d)", MinStickyWidth, MaxStickyWidth)
	}
	return nil
}

// wrapSticky builds a validation error whose message is what the user sees.
// It keeps ErrStickyBoard in the chain so the handler can classify with
// errors.Is (400 vs 500) without matching on strings.
func wrapSticky(format string, args ...any) error {
	return boardError{msg: fmt.Sprintf(format, args...)}
}

type boardError struct{ msg string }

func (e boardError) Error() string { return e.msg }
func (e boardError) Unwrap() error { return ErrStickyBoard }

// StickyStore persists one board per user. Two implementations, the same split
// TokenStore and PreferenceStore use: Postgres in multi mode (shared across
// replicas, no ReadWriteMany secrets volume) and a JSON file in the secrets
// directory in single mode (no database dependency for a single-box install).
type StickyStore interface {
	Get(userID int) ([]Sticky, error)
	Set(userID int, cards []Sticky) error
}

// --- Postgres ---------------------------------------------------------------

// PostgresStickyStore stores the whole board as one JSON document per user in
// the user_stickies table.
type PostgresStickyStore struct {
	db *DB
}

// NewPostgresStickyStore creates a Postgres-backed sticky store.
func NewPostgresStickyStore(db *DB) *PostgresStickyStore {
	return &PostgresStickyStore{db: db}
}

func (s *PostgresStickyStore) Get(userID int) ([]Sticky, error) {
	var data string
	err := s.db.QueryRow(
		`SELECT data FROM user_stickies WHERE user_id = $1`, userID).Scan(&data)
	if err != nil {
		// No row is an empty board, not an error: the first GET happens
		// before anything has ever been saved.
		if errors.Is(err, sql.ErrNoRows) {
			return []Sticky{}, nil
		}
		return nil, err
	}
	return decodeBoard([]byte(data))
}

func (s *PostgresStickyStore) Set(userID int, cards []Sticky) error {
	data, err := json.Marshal(cards)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`
		INSERT INTO user_stickies (user_id, data, updated_at)
		VALUES ($1, $2, NOW())
		ON CONFLICT (user_id) DO UPDATE
		  SET data = EXCLUDED.data, updated_at = NOW()`,
		userID, string(data))
	return err
}

// --- File (single mode) ------------------------------------------------------

// FileStickyStore stores boards in stickies.json under the secrets directory.
//
// The secrets directory — not NOTES_DIR/.sticky, which is where this feature
// was first sketched. Two reasons, and the second one is the load-bearing
// half. /data/notes is not itself a volume: setup.sh bind-mounts each MOUNT_
// namespace individually, so anything the backend creates under NOTES_DIR at
// runtime lands in the container's writable layer and is destroyed by
// `mdnest-server rebuild`. The secrets dir is a declared named volume that
// already holds auth.json, tokens.json and preferences.json, so a board
// survives a rebuild — and it is equally invisible to git-sync, which walks
// /data/notes/*/ only. Privacy without losing the data was the point.
type FileStickyStore struct {
	dir   string
	mu    sync.RWMutex
	users map[string][]Sticky
	// Set when stickies.json exists but could not be read or parsed. Get
	// reports it instead of serving an empty board — see load.
	loadErr error
}

// NewFileStickyStore creates a file-backed sticky store rooted at dir.
func NewFileStickyStore(dir string) *FileStickyStore {
	s := &FileStickyStore{dir: dir, users: map[string][]Sticky{}}
	s.load()
	return s
}

func (s *FileStickyStore) path() string {
	return filepath.Join(s.dir, "stickies.json")
}

// load reads stickies.json into memory.
//
// A missing file is a first run and stays silent. Anything else — unreadable,
// or present but not parseable — is REMEMBERED rather than swallowed, and the
// server still starts (a scratch board is not worth refusing to boot over)
// but every read reports the failure.
//
// The swallowing version is the dangerous one, and it is what shipped here
// first: starting with an empty map makes a broken file look like a new one,
// and the next save writes that empty map over the file. The same reasoning
// as decodeBoard above — a soft failure on read destroys the data when the
// write replaces the whole object.
func (s *FileStickyStore) load() {
	data, err := os.ReadFile(s.path())
	if err != nil {
		if !os.IsNotExist(err) {
			s.loadErr = fmt.Errorf("cannot read stickies.json: %w", err)
			log.Printf("warning: %v — sticky boards will not be served until this is fixed", s.loadErr)
		}
		return
	}
	var wrap struct {
		Users map[string][]Sticky `json:"users"`
	}
	if err := json.Unmarshal(data, &wrap); err != nil {
		s.loadErr = fmt.Errorf("stickies.json is not valid JSON: %w", err)
		log.Printf("warning: %v — the file is left untouched; fix or move it to start fresh", s.loadErr)
		return
	}
	if wrap.Users != nil {
		s.users = wrap.Users
	}
}

// save writes the in-memory store to disk. Caller holds the write lock.
//
// Write-to-temp-then-rename, unlike the preference store's plain WriteFile: a
// board is the user's own content rather than a setting they can re-pick in
// one click, and a truncated file from a crash mid-write would lose all of it.
// Rename within the same directory is atomic on every filesystem mdnest runs
// on, so a reader sees either the old board or the new one.
func (s *FileStickyStore) save() error {
	wrap := struct {
		Users map[string][]Sticky `json:"users"`
	}{Users: s.users}
	data, err := json.MarshalIndent(wrap, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "stickies-*.json.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op once the rename succeeds
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.path())
}

func (s *FileStickyStore) Get(userID int) ([]Sticky, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.loadErr != nil {
		return nil, s.loadErr
	}
	stored := s.users[strconv.Itoa(userID)]
	out := make([]Sticky, len(stored))
	copy(out, stored)
	return out, nil
}

func (s *FileStickyStore) Set(userID int, cards []Sticky) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cards == nil {
		cards = []Sticky{}
	}
	s.users[strconv.Itoa(userID)] = cards
	return s.save()
}

// decodeBoard turns stored JSON back into cards.
//
// A board that will not parse is an ERROR, not an empty board. The tempting
// version logs a warning and returns nothing, which reads as robust and is
// the opposite: the client cannot tell that empty board from a real one, and
// because a board is written back WHOLE, the next keystroke replaces the
// unreadable-but-present data with one card. This is the same trap the
// frontend's fetchStickies fell into — fail-soft read plus whole-object write
// destroys exactly the data the soft failure was trying to be gentle about.
// Failing here surfaces as a 500, the client refuses to save, and whatever is
// in the column stays there to be recovered by hand.
func decodeBoard(data []byte) ([]Sticky, error) {
	if len(data) == 0 {
		return []Sticky{}, nil
	}
	var cards []Sticky
	if err := json.Unmarshal(data, &cards); err != nil {
		return nil, fmt.Errorf("stored sticky board is not valid JSON: %w", err)
	}
	if cards == nil {
		cards = []Sticky{}
	}
	return cards, nil
}

// compile-time checks
var (
	_ StickyStore = (*PostgresStickyStore)(nil)
	_ StickyStore = (*FileStickyStore)(nil)
)
