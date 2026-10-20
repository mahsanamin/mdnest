package storage

import (
	"bytes"
	"testing"
)

func TestEncodeDecodeOpRoundTrip(t *testing.T) {
	ops := []DurabilityOp{
		{Kind: OpWrite, NS: "team", Path: "a/b.md", Data: []byte("hello\x00binary")},
		{Kind: OpRemove, NS: "team", Path: "a/b.md"},
		{Kind: OpRemoveAll, NS: "team", Path: "dir"},
		{Kind: OpRename, NS: "team", Path: "old.md", To: "new.md"},
		{Kind: OpMkdir, NS: "team", Path: "dir/sub"},
	}
	for _, op := range ops {
		got := decodeOp("42-0", encodeOp(op))
		if got.Kind != op.Kind || got.NS != op.NS || got.Path != op.Path || got.To != op.To {
			t.Fatalf("scalar mismatch for %s: got %+v want %+v", op.Kind, got, op)
		}
		if !bytes.Equal(got.Data, op.Data) {
			t.Fatalf("data mismatch for %s: got %q want %q", op.Kind, got.Data, op.Data)
		}
		if got.Seq != "42-0" {
			t.Fatalf("seq not carried: %q", got.Seq)
		}
	}
}

func TestNextStreamID(t *testing.T) {
	cases := map[string]string{
		"5-3":                    "5-4",
		"1700000000000-0":        "1700000000000-1",
		"7-18446744073709551615": "8-0",
		"":                       "",
		"0-0":                    "",
		"garbage":                "",
		"1-x":                    "",
	}
	for in, want := range cases {
		got, ok := nextStreamID(in)
		if ok != (want != "") || got != want {
			t.Errorf("nextStreamID(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
}
