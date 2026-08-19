package handlers

import "testing"

// The cache is only safe because a hit requires an identical signature. These
// pin that contract: same signature hits, any change misses, and a hit hands
// back a copy so one caller's sorting cannot corrupt the next one's view.
func TestTaskCacheHitRequiresMatchingSignature(t *testing.T) {
	c := newTaskCache(4)
	tasks := []Task{{Text: "one"}, {Text: "two"}}
	c.put("ns", "sig-a", tasks)

	if got, ok := c.get("ns", "sig-a"); !ok || len(got) != 2 {
		t.Fatalf("expected a hit with 2 tasks, got ok=%v len=%d", ok, len(got))
	}
	if _, ok := c.get("ns", "sig-b"); ok {
		t.Fatal("a changed signature must miss — this is what stops stale tasks being served")
	}
	if _, ok := c.get("other", "sig-a"); ok {
		t.Fatal("namespaces must not share an entry")
	}
}

func TestTaskCacheReturnsACopy(t *testing.T) {
	c := newTaskCache(4)
	c.put("ns", "sig", []Task{{Text: "original"}})

	first, _ := c.get("ns", "sig")
	first[0].Text = "mutated by the caller"

	second, ok := c.get("ns", "sig")
	if !ok || second[0].Text != "original" {
		t.Fatalf("cached entry was mutated through a returned slice: %q", second[0].Text)
	}
}

func TestTaskCachePutCopiesInput(t *testing.T) {
	c := newTaskCache(4)
	src := []Task{{Text: "original"}}
	c.put("ns", "sig", src)
	src[0].Text = "changed after caching"

	got, _ := c.get("ns", "sig")
	if got[0].Text != "original" {
		t.Fatalf("cache aliased the caller's slice: %q", got[0].Text)
	}
}

func TestTaskCacheIsBounded(t *testing.T) {
	c := newTaskCache(2)
	c.put("a", "s", []Task{{Text: "a"}})
	c.put("b", "s", []Task{{Text: "b"}})
	c.put("c", "s", []Task{{Text: "c"}})
	if len(c.entries) > 2 {
		t.Fatalf("cache grew past its bound: %d entries", len(c.entries))
	}
	if _, ok := c.get("c", "s"); !ok {
		t.Fatal("the newest entry should survive eviction")
	}
}

func TestNilTaskCacheIsSafe(t *testing.T) {
	var c *taskCache
	if _, ok := c.get("ns", "sig"); ok {
		t.Fatal("a nil cache must simply miss")
	}
	c.put("ns", "sig", []Task{{Text: "x"}}) // must not panic
}

// A column rename changes how tasks are bucketed, so it has to invalidate the
// cache exactly like an edit does.
func TestBoardSignatureChangesWithTheLayout(t *testing.T) {
	a := BoardConfig{Columns: []BoardColumn{{ID: "todo", Title: "To Do"}, {ID: "done", Title: "Done", Done: true}}}
	b := BoardConfig{Columns: []BoardColumn{{ID: "todo", Title: "Backlog"}, {ID: "done", Title: "Done", Done: true}}}
	if boardSignature(a) == boardSignature(b) {
		t.Fatal("renaming a column must change the signature")
	}
	if boardSignature(a) != boardSignature(a) {
		t.Fatal("the signature must be stable for an unchanged board")
	}
}
