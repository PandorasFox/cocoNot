package cache

import (
	"path/filepath"
	"testing"
)

func TestBuildAndLoad(t *testing.T) {
	yes := true
	no := false

	products := []PreparedProduct{
		{Code: "001", Name: "Coconut Bar", ContainsCoconut: &yes},
		{Code: "002", Name: "Plain Chips", ContainsCoconut: &no},
		{Code: "003", Name: "Mystery Food", ContainsCoconut: nil},
		{Code: "004", Name: "Tab\tName\nNewline", ContainsCoconut: &no}, // nasty chars
	}

	c, err := Build(products)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}

	if c.Count() != 4 {
		t.Fatalf("count: got %d, want 4", c.Count())
	}

	// Check lookups
	e := c.Lookup("001")
	if e == nil || e.Name != "Coconut Bar" || e.ContainsCoconut == nil || !*e.ContainsCoconut {
		t.Errorf("001 lookup wrong: %+v", e)
	}
	e = c.Lookup("003")
	if e == nil || e.ContainsCoconut != nil {
		t.Errorf("003 should have nil coconut: %+v", e)
	}
	if c.Lookup("999") != nil {
		t.Error("999 should be nil")
	}

	// Write and reload
	dir := t.TempDir()
	path := filepath.Join(dir, "skus.tsv.gz")
	if err := c.WriteFile(path); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	loaded, err := LoadFile(path)
	if err != nil {
		t.Fatalf("LoadFile: %v", err)
	}

	if loaded.Count() != 4 {
		t.Fatalf("loaded count: got %d, want 4", loaded.Count())
	}

	// Verify round-trip (names are sanitized through TSV, so compare against sanitized originals)
	for _, code := range []string{"001", "002", "003"} {
		orig := c.Lookup(code)
		got := loaded.Lookup(code)
		if got == nil {
			t.Errorf("missing %s after reload", code)
			continue
		}
		if got.Name != orig.Name {
			t.Errorf("%s name: got %q, want %q", code, got.Name, orig.Name)
		}
		if (got.ContainsCoconut == nil) != (orig.ContainsCoconut == nil) {
			t.Errorf("%s coconut nil mismatch", code)
		} else if got.ContainsCoconut != nil && *got.ContainsCoconut != *orig.ContainsCoconut {
			t.Errorf("%s coconut: got %v, want %v", code, *got.ContainsCoconut, *orig.ContainsCoconut)
		}
	}

	// Tab/newline in name get sanitized to spaces through TSV round-trip
	e = loaded.Lookup("004")
	if e == nil {
		t.Fatal("004 missing after reload")
	}
	if e.Name != "Tab Name Newline" {
		t.Errorf("004 name after round-trip: got %q, want %q", e.Name, "Tab Name Newline")
	}
	// Coconut status should survive round-trip
	if e.ContainsCoconut == nil || *e.ContainsCoconut {
		t.Errorf("004 coconut after round-trip: got %v, want false", e.ContainsCoconut)
	}

	// Meta
	meta := loaded.Meta()
	if meta.Count != 4 {
		t.Errorf("meta count: %d", meta.Count)
	}
	if meta.CompressedBytes == 0 {
		t.Error("meta compressed bytes is 0")
	}
	if meta.BaseURL != offBaseURL {
		t.Errorf("meta base_url: %q", meta.BaseURL)
	}
}

func TestBatchLookup(t *testing.T) {
	yes := true
	products := []PreparedProduct{
		{Code: "aaa", Name: "A", ContainsCoconut: &yes},
		{Code: "bbb", Name: "B", ContainsCoconut: nil},
	}

	c, err := Build(products)
	if err != nil {
		t.Fatal(err)
	}

	results := c.LookupBatch([]string{"aaa", "bbb", "zzz"})
	if len(results) != 2 {
		t.Fatalf("batch: got %d results, want 2", len(results))
	}
	if _, ok := results["zzz"]; ok {
		t.Error("zzz should not be in results")
	}
}
