package handlers

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mdnest/mdnest/backend/storage"
)

// A GET that lands while a PUT writes the same note must see the old text or
// the new one, never an empty or half-written file. The file is written in
// place (truncate, then write), so without the note lock on the read a
// browser merging "the file" against its own text got "" and dropped every
// word it had saved (tests/browser/live-never-blocks.spec.js (h)).
func TestGetNote_NeverSeesAHalfWrittenFile(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	h := NewNoteHandler(stg)
	a := strings.Repeat("a", 256<<10) + "\n"
	b := strings.Repeat("b", 256<<10) + "\n"
	if err := os.WriteFile(filepath.Join(root, "alpha", "n.md"), []byte(a), 0o644); err != nil {
		t.Fatal(err)
	}

	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; ; i++ {
			select {
			case <-stop:
				return
			default:
			}
			body := a
			if i%2 == 1 {
				body = b
			}
			w := httptest.NewRecorder()
			h.Handle(w, httptest.NewRequest(http.MethodPut, "/api/note?ns=alpha&path=n.md", strings.NewReader(body)))
		}
	}()
	bad := 0
	for i := 0; i < 120; i++ {
		w := httptest.NewRecorder()
		h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/note?ns=alpha&path=n.md", nil))
		if w.Code != http.StatusOK {
			continue
		}
		got := w.Body.String()
		if got != a && got != b {
			bad++
		}
	}
	close(stop)
	wg.Wait()
	if bad > 0 {
		t.Fatalf("%d of 120 reads saw a half-written note", bad)
	}
}

// The note lock is not reentrant. GET takes it now, so every path that holds
// it (PUT, PATCH append, chat post) must still finish while reads of the same
// note keep coming: none of them reads through the GET handler.
func TestNoteLock_WritersFinishWhileReadsRun(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "work"), 0o755); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	notes := NewNoteHandler(stg)
	chat := NewChatHandler(stg,
		func(_ *http.Request, names []string) []string { return names },
		func(_ *http.Request, _, _ string) bool { return true }, "ahsan", false)
	do := func(fn http.HandlerFunc, method, url, body string) int {
		w := httptest.NewRecorder()
		fn(w, httptest.NewRequest(method, url, strings.NewReader(body)))
		return w.Code
	}
	if c := do(notes.Handle, http.MethodPost, "/api/note?ns=work&path=n.md", "start\n"); c != http.StatusCreated {
		t.Fatalf("create note: %d", c)
	}
	if c := do(chat.HandleConvert, http.MethodPost, "/api/chat/convert?ns=work&path=c.md&title=T", ""); c >= 300 {
		t.Fatalf("convert: %d", c)
	}

	stop := make(chan struct{})
	var readers sync.WaitGroup
	for _, p := range []string{"n.md", "c.md"} {
		for i := 0; i < 4; i++ {
			readers.Add(1)
			go func(p string) {
				defer readers.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					do(notes.Handle, http.MethodGet, "/api/note?ns=work&path="+p, "")
				}
			}(p)
		}
	}
	done := make(chan struct{})
	go func() {
		for i := 0; i < 50; i++ {
			do(notes.Handle, http.MethodPatch, "/api/note?ns=work&path=n.md", "line\n")
			do(notes.Handle, http.MethodPut, "/api/note?ns=work&path=n.md", "replaced\n")
			do(chat.Handle, http.MethodPost, "/api/chat?ns=work&path=c.md", "hello")
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("writers did not finish while reads ran (a deadlock on the note lock?)")
	}
	close(stop)
	readers.Wait()
	b, _ := os.ReadFile(filepath.Join(root, "work", "c.md"))
	if n := strings.Count(string(b), "hello"); n != 50 {
		t.Fatalf("chat holds %d of 50 posts", n)
	}
}

// Reads wait behind a write of the same note, but only for that write: many
// readers during back-to-back large writes all finish, in bounded time.
func TestNoteLock_ReadersDoNotPileUp(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	stg, err := storage.NewLocalStorage(root)
	if err != nil {
		t.Fatal(err)
	}
	h := NewNoteHandler(stg)
	// 256 KB, not 1 MB: under -race one 1 MB GET costs about 0.7 s of CPU
	// outside the lock, so 50 of them ran out the clock on an 8-core box
	// whether or not the lock was fair. The size does not change what this
	// pins: reads queue behind one write at a time and all finish.
	big := strings.Repeat("x", 1<<18) + "\n"
	if err := os.WriteFile(filepath.Join(root, "alpha", "n.md"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			w := httptest.NewRecorder()
			h.Handle(w, httptest.NewRequest(http.MethodPut, "/api/note?ns=alpha&path=n.md", strings.NewReader(big)))
		}
	}()
	defer close(stop)
	var wg sync.WaitGroup
	start := time.Now()
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := httptest.NewRecorder()
			h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/note?ns=alpha&path=n.md", nil))
		}()
	}
	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
		t.Logf("50 reads during 256 KB writes finished in %s", time.Since(start))
	case <-time.After(15 * time.Second):
		t.Fatal("readers piled up behind the writes")
	}
}
