package handlers

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/mdnest/mdnest/backend/middleware"
)

const pagesTestSecret = "pages-test-secret"

type tarEntry struct {
	name     string
	body     string
	typeflag byte
	link     string
}

func makeTar(t *testing.T, entries ...tarEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	for _, e := range entries {
		tf := e.typeflag
		if tf == 0 {
			tf = tar.TypeReg
		}
		hdr := &tar.Header{Name: e.name, Mode: 0644, Typeflag: tf, Linkname: e.link}
		if tf == tar.TypeReg {
			hdr.Size = int64(len(e.body))
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if tf == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	return buf.Bytes()
}

// pagesFixture: notes root with namespace "alpha", an empty PAGES_DIR beside
// it, and a static-mode handler with small limits.
func pagesFixture(t *testing.T, mutate ...func(*PagesConfig)) (*PagesHandler, string) {
	t.Helper()
	root := t.TempDir()
	notes := filepath.Join(root, "notes")
	os.MkdirAll(filepath.Join(notes, "alpha"), 0o755)
	pagesDir := filepath.Join(root, "pages")
	os.MkdirAll(pagesDir, 0o755)
	cfg := PagesConfig{
		Dir:            pagesDir,
		MaxBytes:       64 << 10,
		MaxFiles:       5,
		FrameAncestors: "https://notes.example.com",
		Secret:         []byte(pagesTestSecret),
		SingleUser:     "admin",
	}
	for _, m := range mutate {
		m(&cfg)
	}
	return NewPagesHandler(cfg, localStore(t, notes), nil), pagesDir
}

func publish(h *PagesHandler, ns, slug, ct string, body []byte) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPut, "/api/pages?ns="+ns+"&slug="+slug, bytes.NewReader(body))
	r.Header.Set("Content-Type", ct)
	w := httptest.NewRecorder()
	h.Handle(w, r)
	return w
}

func passURL(t *testing.T, h *PagesHandler, ns, slug string) string {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/pages/pass?ns="+ns+"&slug="+slug, nil)
	w := httptest.NewRecorder()
	h.HandlePass(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("pass: %d %s", w.Code, w.Body.String())
	}
	var resp struct {
		URL     string `json:"url"`
		Scripts bool   `json:"scripts"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	return resp.URL
}

func view(h *PagesHandler, url string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodGet, url, nil)
	w := httptest.NewRecorder()
	h.HandleStaticView(w, r)
	return w
}

func TestPages_PublishListViewText(t *testing.T) {
	h, _ := pagesFixture(t)
	page := makeTar(t,
		tarEntry{name: "./", typeflag: tar.TypeDir},
		tarEntry{name: "./index.html", body: `<html><head><title>Q3 report</title><style>.x{}</style></head><body><h1>Revenue</h1><p>grew by 12%</p><script>var secretCode=1</script><img src="img/chart.png"></body></html>`},
		tarEntry{name: "./img/", typeflag: tar.TypeDir},
		tarEntry{name: "./img/chart.png", body: "PNGDATA"},
		tarEntry{name: "./.DS_Store", body: "junk"},
	)
	if w := publish(h, "alpha", "q3-report", "application/x-tar", page); w.Code != http.StatusOK {
		t.Fatalf("publish: %d %s", w.Code, w.Body.String())
	}

	// List: one row, title from <title>, author from MDNEST_USER in single mode.
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha", nil))
	var list struct{ Pages []PageMeta }
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Pages) != 1 || list.Pages[0].Title != "Q3 report" || list.Pages[0].Author != "admin" || list.Pages[0].Files != 2 {
		t.Fatalf("list = %+v", list.Pages)
	}
	if list.Pages[0].Text != "" {
		t.Fatal("the list must not carry the page text")
	}

	// Search runs on the stored text, never on script content.
	for q, want := range map[string]int{"revenue": 1, "grew 12%": 1, "secretCode": 0, "nothing-here": 0} {
		w := httptest.NewRecorder()
		h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha&q="+strings.ReplaceAll(q, " ", "+"), nil))
		var l struct{ Pages []PageMeta }
		json.Unmarshal(w.Body.Bytes(), &l)
		if len(l.Pages) != want {
			t.Errorf("q=%q: %d results, want %d", q, len(l.Pages), want)
		}
	}

	// TSV for the CLI: one line per page, no tabs inside fields.
	w = httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha&format=tsv", nil))
	if lines := strings.Split(strings.TrimSpace(w.Body.String()), "\n"); len(lines) != 1 || len(strings.Split(lines[0], "\t")) != 6 || !strings.HasPrefix(lines[0], "q3-report\tQ3 report\tadmin\t") {
		t.Fatalf("tsv = %q", w.Body.String())
	}

	// Text: extracted once, without HTML or script.
	w = httptest.NewRecorder()
	h.HandleText(w, httptest.NewRequest(http.MethodGet, "/api/pages/text?ns=alpha&slug=q3-report", nil))
	var m PageMeta
	json.Unmarshal(w.Body.Bytes(), &m)
	if m.Text != "Revenue grew by 12%" {
		t.Fatalf("text = %q", m.Text)
	}

	// View through a pass: index, then a file in a subfolder.
	u := passURL(t, h, "alpha", "q3-report")
	if !strings.HasPrefix(u, "/api/pages/view/") || !strings.HasSuffix(u, "/") {
		t.Fatalf("static pass url = %q", u)
	}
	w = view(h, u)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "<h1>Revenue</h1>") {
		t.Fatalf("index: %d %s", w.Code, w.Body.String())
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.HasSuffix(csp, "; sandbox") || strings.Contains(csp, "allow-scripts") || strings.Contains(csp, "script-src") {
		t.Fatalf("static CSP must turn scripts off: %q", csp)
	}
	if !strings.Contains(csp, "frame-ancestors https://notes.example.com") {
		t.Fatalf("static CSP must name the frontend as the only framer: %q", csp)
	}
	for k, v := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"Referrer-Policy":        "no-referrer",
		"Cache-Control":          "private, no-store",
		"Content-Type":           "text/html; charset=utf-8",
	} {
		if got := w.Header().Get(k); got != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
	if w = view(h, u+"img/chart.png"); w.Code != http.StatusOK || w.Body.String() != "PNGDATA" {
		t.Fatalf("image: %d %q", w.Code, w.Body.String())
	}
	// The hidden file was never stored.
	if w = view(h, u+".DS_Store"); w.Code != http.StatusNotFound {
		t.Fatalf(".DS_Store: %d", w.Code)
	}
	// Without the trailing slash relative links would break: redirect.
	if w = view(h, strings.TrimSuffix(u, "/")); w.Code != http.StatusFound || w.Header().Get("Location") != u {
		t.Fatalf("no-slash: %d %q", w.Code, w.Header().Get("Location"))
	}
}

func TestPages_SingleHTMLFileAndRepublishReplaces(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	page := makeTar(t, tarEntry{name: "index.html", body: "<p>one</p>"}, tarEntry{name: "old.css", body: "x"})
	if w := publish(h, "alpha", "rep", "application/x-tar", page); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if w := publish(h, "alpha", "rep", "text/html; charset=utf-8", []byte("<title>Two</title><p>two</p>")); w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", "rep", "old.css")); !os.IsNotExist(err) {
		t.Fatal("republishing must replace the page, not merge into it")
	}
	b, _ := os.ReadFile(filepath.Join(pagesDir, "alpha", "rep", "index.html"))
	if string(b) != "<title>Two</title><p>two</p>" {
		t.Fatalf("index = %q", b)
	}
	// No temp or old folders left behind.
	entries, _ := os.ReadDir(filepath.Join(pagesDir, "alpha"))
	for _, e := range entries {
		if e.Name() != "rep" && e.Name() != pagesMetaDir {
			t.Errorf("left behind: %s", e.Name())
		}
	}
	// Delete removes files and details.
	w := httptest.NewRecorder()
	h.Handle(w, httptest.NewRequest(http.MethodDelete, "/api/pages?ns=alpha&slug=rep", nil))
	if w.Code != http.StatusOK {
		t.Fatal(w.Body.String())
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", "rep")); !os.IsNotExist(err) {
		t.Fatal("page folder still there")
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", pagesMetaDir, "rep.json")); !os.IsNotExist(err) {
		t.Fatal("page details still there")
	}
}

func TestPages_SlugRules(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	bad := []string{"", ".pages-meta", ".hidden", "Upper", "a_b", "a.b", "..", "a/b", "%2e%2e", strings.Repeat("a", 65), "ünicode"}
	for _, s := range bad {
		if ValidPageSlug(s) {
			t.Errorf("ValidPageSlug(%q) = true", s)
		}
		if w := publish(h, "alpha", s, "text/html", []byte("<p>x</p>")); w.Code != http.StatusBadRequest {
			t.Errorf("publish slug %q: %d", s, w.Code)
		}
	}
	for _, s := range []string{"a", "q3-report", strings.Repeat("a", 64), "0-9"} {
		if !ValidPageSlug(s) {
			t.Errorf("ValidPageSlug(%q) = false", s)
		}
	}
	// Nothing was written for any refused slug.
	entries, _ := os.ReadDir(filepath.Join(pagesDir, "alpha"))
	for _, e := range entries {
		if e.Name() != pagesMetaDir {
			t.Errorf("refused slug left %s", e.Name())
		}
	}
}

func TestPages_NamespaceMustExist(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	if w := publish(h, "nope", "x", "text/html", []byte("<p>x</p>")); w.Code != http.StatusNotFound {
		t.Fatalf("unknown namespace: %d", w.Code)
	}
	if w := publish(h, "..", "x", "text/html", []byte("<p>x</p>")); w.Code != http.StatusBadRequest {
		t.Fatalf("namespace ..: %d", w.Code)
	}
	if _, err := os.Stat(filepath.Join(pagesDir, "nope")); !os.IsNotExist(err) {
		t.Fatal("pages must never create a namespace folder for an unknown namespace")
	}
}

func TestPages_TarIsPlainFilesOnly(t *testing.T) {
	h, pagesDir := pagesFixture(t)
	index := tarEntry{name: "index.html", body: "<p>x</p>"}
	cases := map[string][]tarEntry{
		"dotdot":      {index, {name: "../escape.html", body: "x"}},
		"deep-dotdot": {index, {name: "a/../../escape.html", body: "x"}},
		"absolute":    {index, {name: "/etc/escape.html", body: "x"}},
		"git":         {index, {name: ".git/config", body: "x"}},
		"deep-git":    {index, {name: "a/.git/hooks/x", body: "y"}},
		"symlink":     {index, {name: "link", typeflag: tar.TypeSymlink, link: "/etc/passwd"}},
		"hardlink":    {index, {name: "hard", typeflag: tar.TypeLink, link: "index.html"}},
		"chardev":     {index, {name: "dev", typeflag: tar.TypeChar}},
		"blockdev":    {index, {name: "blk", typeflag: tar.TypeBlock}},
		"fifo":        {index, {name: "pipe", typeflag: tar.TypeFifo}},
		"duplicate":   {index, {name: "a.css", body: "1"}, {name: "./a.css", body: "2"}},
		"no-index":    {{name: "other.html", body: "x"}},
	}
	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			w := publish(h, "alpha", "p-"+name, "application/x-tar", makeTar(t, entries...))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("want 400, got %d %s", w.Code, w.Body.String())
			}
			if _, err := os.Stat(filepath.Join(pagesDir, "alpha", "p-"+name)); !os.IsNotExist(err) {
				t.Fatal("a refused page was stored")
			}
		})
	}
	// Nothing landed outside the namespace's pages folder.
	for _, p := range []string{filepath.Join(pagesDir, "escape.html"), filepath.Join(pagesDir, "alpha", "escape.html"), filepath.Join(filepath.Dir(pagesDir), "escape.html")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("escaped write: %s", p)
		}
	}
}

func TestPages_Limits(t *testing.T) {
	h, pagesDir := pagesFixture(t) // 64 KB, 5 files
	index := tarEntry{name: "index.html", body: "<p>x</p>"}

	big := strings.Repeat("a", 65<<10)
	if w := publish(h, "alpha", "big-html", "text/html", []byte(big)); w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "PAGES_MAX_MB") {
		t.Fatalf("big html: %d %s", w.Code, w.Body.String())
	}
	if w := publish(h, "alpha", "big-tar", "application/x-tar", makeTar(t, index, tarEntry{name: "a.bin", body: big})); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("big tar: %d %s", w.Code, w.Body.String())
	}
	many := []tarEntry{index}
	for i := 0; i < 5; i++ {
		many = append(many, tarEntry{name: "f" + string(rune('a'+i)) + ".txt", body: "x"})
	}
	if w := publish(h, "alpha", "many", "application/x-tar", makeTar(t, many...)); w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "PAGES_MAX_FILES") {
		t.Fatalf("too many files: %d %s", w.Code, w.Body.String())
	}

	// A gzip bomb: tiny on the wire, 200 MB inflated, with a header that lies
	// about its size. The decompressed bytes are counted, so it stops at the
	// limit instead of filling the disk.
	var raw bytes.Buffer
	tw := tar.NewWriter(&raw)
	tw.WriteHeader(&tar.Header{Name: "index.html", Mode: 0644, Size: 200 << 20, Typeflag: tar.TypeReg})
	zero := make([]byte, 1<<20)
	var gz bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	zw.Write(raw.Bytes())
	for i := 0; i < 200; i++ {
		zw.Write(zero)
	}
	zw.Close()
	if gz.Len() > 1<<20 {
		t.Fatalf("bomb is %d bytes on the wire, test is wrong", gz.Len())
	}
	start := time.Now()
	if w := publish(h, "alpha", "bomb", "application/gzip", gz.Bytes()); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("gzip bomb: %d %s", w.Code, w.Body.String())
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("gzip bomb took too long: limit not applied while inflating")
	}
	// Same bomb with an honest header but a small limit: stops while copying.
	if _, err := os.Stat(filepath.Join(pagesDir, "alpha", "bomb")); !os.IsNotExist(err) {
		t.Fatal("bomb stored")
	}

	// An unknown content type is refused.
	if w := publish(h, "alpha", "zip", "application/zip", []byte("PK")); w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("zip: %d", w.Code)
	}
}

func TestPages_PassRules(t *testing.T) {
	h, _ := pagesFixture(t)
	publish(h, "alpha", "one", "text/html", []byte("<p>ONE</p>"))
	publish(h, "alpha", "two", "text/html", []byte("<p>TWO</p>"))
	u := passURL(t, h, "alpha", "one")
	pass := strings.TrimSuffix(strings.TrimPrefix(u, "/api/pages/view/"), "/")

	// A pass is never a login.
	if _, err := middleware.ParseSessionToken([]byte(pagesTestSecret), pass); err == nil {
		t.Fatal("a page pass was accepted as a session token")
	}
	// A session token is never a pass.
	session, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "admin", "ns": "alpha", "slug": "one", "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(pagesTestSecret))
	if w := view(h, "/api/pages/view/"+session+"/"); w.Code != http.StatusForbidden {
		t.Fatalf("session token as pass: %d", w.Code)
	}

	// The pass names one page; there is no way to name another through it.
	if w := view(h, u+"../two/index.html"); strings.Contains(w.Body.String(), "TWO") {
		t.Fatal("pass for one served page two")
	}

	var c0 pageClaims
	jwt.ParseWithClaims(pass, &c0, func(*jwt.Token) (any, error) { return []byte(pagesTestSecret), nil })
	if c0.Version == "" {
		t.Fatal("pass carries no version")
	}
	mint := func(claims jwt.MapClaims, secret string) string {
		s, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(secret))
		return s
	}
	base := jwt.MapClaims{"purpose": "page", "ns": "alpha", "slug": "one", "v": c0.Version}
	with := func(k string, v any) jwt.MapClaims {
		c := jwt.MapClaims{}
		for a, b := range base {
			c[a] = b
		}
		c[k] = v
		return c
	}
	withExp := func(k string, v any) jwt.MapClaims {
		c := with(k, v)
		c["exp"] = time.Now().Add(time.Hour).Unix()
		return c
	}
	// Control: a correct hand-made pass opens the page, so each case below
	// fails for its own reason only.
	if w := view(h, "/api/pages/view/"+mint(withExp("v", c0.Version), pagesTestSecret)+"/"); w.Code != http.StatusOK {
		t.Fatalf("control pass: %d", w.Code)
	}
	cases := map[string]string{
		"expired":       mint(with("exp", time.Now().Add(-time.Minute).Unix()), pagesTestSecret),
		"no-expiry":     mint(base, pagesTestSecret),
		"wrong-secret":  mint(with("exp", time.Now().Add(time.Hour).Unix()), "other"),
		"bad-slug":      mint(with("slug", "../alpha"), pagesTestSecret),
		"no-version":    mint(withExp("v", ""), pagesTestSecret),
		"wrong-version": mint(withExp("v", "0000"), pagesTestSecret),
		"tampered":      pass[:len(pass)-2] + "xx",
	}
	for name, p := range cases {
		w := view(h, "/api/pages/view/"+p+"/")
		if w.Code != http.StatusForbidden {
			t.Errorf("%s: %d", name, w.Code)
		}
		if w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: error response missing safety headers", name)
		}
	}
	// A pass is bound to the version it was made for: after a republish it
	// no longer opens the page, and a new pass does.
	if w := view(h, u); w.Code != http.StatusOK {
		t.Fatalf("pass before republish: %d", w.Code)
	}
	publish(h, "alpha", "one", "text/html", []byte("<p>ONE v2</p>"))
	if w := view(h, u); w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "v2") {
		t.Fatalf("old pass after republish: %d %s", w.Code, w.Body.String())
	}
	if w := view(h, passURL(t, h, "alpha", "one")); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "v2") {
		t.Fatalf("new pass after republish: %d", w.Code)
	}
	// ...and after a delete and a new page with the same name.
	u2 := passURL(t, h, "alpha", "two")
	dw := httptest.NewRecorder()
	h.Handle(dw, httptest.NewRequest(http.MethodDelete, "/api/pages?ns=alpha&slug=two", nil))
	publish(h, "alpha", "two", "text/html", []byte("<p>NEW TWO</p>"))
	if w := view(h, u2); w.Code != http.StatusForbidden {
		t.Fatalf("old pass after delete and recreate: %d", w.Code)
	}
	// The version never shows in an API response.
	lw := httptest.NewRecorder()
	h.Handle(lw, httptest.NewRequest(http.MethodGet, "/api/pages?ns=alpha", nil))
	if strings.Contains(lw.Body.String(), "version") {
		t.Fatalf("list leaks the version: %s", lw.Body.String())
	}

	// A fresh pass lasts 30 minutes by default.
	var c pageClaims
	jwt.ParseWithClaims(pass, &c, func(*jwt.Token) (any, error) { return []byte(pagesTestSecret), nil })
	if left := time.Until(c.ExpiresAt.Time); left < 29*time.Minute || left > 31*time.Minute {
		t.Fatalf("pass lifetime %v, want 30m", left)
	}
	// Only GET and HEAD.
	r := httptest.NewRequest(http.MethodPost, u, nil)
	w := httptest.NewRecorder()
	h.HandleStaticView(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST view: %d", w.Code)
	}
}

func TestPages_ScriptModeHeaders(t *testing.T) {
	for _, network := range []string{"strict", "open"} {
		t.Run(network, func(t *testing.T) {
			h, _ := pagesFixture(t, func(c *PagesConfig) {
				c.Origin = "https://pages.example.com"
				c.Network = network
			})
			publish(h, "alpha", "p", "text/html", []byte("<script>1</script>"))
			u := passURL(t, h, "alpha", "p")
			if !strings.HasPrefix(u, "https://pages.example.com/") {
				t.Fatalf("script-mode url = %q", u)
			}
			srv := httptest.NewServer(h.SiteHandler())
			defer srv.Close()
			path := strings.TrimPrefix(u, "https://pages.example.com")
			resp, err := http.Get(srv.URL + path)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != 200 || string(body) != "<script>1</script>" {
				t.Fatalf("%d %q", resp.StatusCode, body)
			}
			csp := resp.Header.Get("Content-Security-Policy")
			if !strings.HasSuffix(csp, "; sandbox allow-scripts") || strings.Contains(csp, "allow-same-origin") {
				t.Fatalf("csp = %q", csp)
			}
			for _, must := range []string{"frame-ancestors https://notes.example.com", "base-uri 'none'", "form-action 'none'", "object-src 'none'"} {
				if !strings.Contains(csp, must) {
					t.Errorf("csp missing %q: %q", must, csp)
				}
			}
			if network == "strict" && (strings.Contains(csp, "https:;") || strings.Contains(csp, "https: ") || !strings.Contains(csp, "connect-src https://pages.example.com")) {
				t.Errorf("strict csp lets the page reach other sites: %q", csp)
			}
			if network == "open" && !strings.Contains(csp, "https:") {
				t.Errorf("open csp = %q", csp)
			}
			if resp.Header.Get("Referrer-Policy") != "no-referrer" || resp.Header.Get("X-Content-Type-Options") != "nosniff" {
				t.Error("missing safety headers")
			}
			// The pages origin serves pages and nothing else.
			for _, p := range []string{"/api/pages?ns=alpha", "/api/config", "/"} {
				resp, _ := http.Get(srv.URL + p)
				if resp.StatusCode == 200 {
					t.Errorf("pages origin answered %s with 200", p)
				}
				resp.Body.Close()
			}
		})
	}
}

func TestResolvePagesOrigin(t *testing.T) {
	cases := []struct {
		pages, front, want string
		refused            bool
	}{
		{"", "https://notes.example.com", "", false},
		{"https://pages.example.com", "https://notes.example.com", "https://pages.example.com", false},
		{"https://notes.example.com:8443/", "https://notes.example.com", "https://notes.example.com:8443", false},
		{"https://notes.example.com", "https://notes.example.com", "", true},
		{"https://NOTES.example.com:443", "https://notes.example.com/", "", true},
		{"http://localhost:3236", "http://localhost:3236", "", true},
		{"ftp://pages", "https://notes.example.com", "", true},
		{"not a url", "https://notes.example.com", "", true},
	}
	for _, c := range cases {
		got, msg := ResolvePagesOrigin(c.pages, c.front)
		if got != c.want || (msg != "") != c.refused {
			t.Errorf("ResolvePagesOrigin(%q, %q) = %q, %q", c.pages, c.front, got, msg)
		}
	}
}

func TestExtractPageText(t *testing.T) {
	title, text := ExtractPageText([]byte(`<!doctype html><html><head><title> My
	Page </title><script>alert("no")</script></head><body><noscript>nojs</noscript><template>tpl</template><p>Hello&amp;bye</p><div>next</div><style>p{color:red}</style></body></html>`))
	if title != "My Page" || text != "Hello&bye next" {
		t.Fatalf("title=%q text=%q", title, text)
	}
}

func TestPagesEnabled(t *testing.T) {
	for _, c := range []struct {
		set, role string
		want      bool
	}{{"", "single", false}, {"true", "single", true}, {"true", "app", false}, {"false", "writer", false}, {"on", "writer", true}} {
		if got := PagesEnabled(c.set, c.role); got != c.want {
			t.Errorf("PagesEnabled(%q,%q) = %v", c.set, c.role, got)
		}
	}
}
