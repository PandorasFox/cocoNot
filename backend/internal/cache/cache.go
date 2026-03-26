package cache

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Entry is the in-memory representation of a cached SKU.
type Entry struct {
	SKU             string
	Name            string
	ContainsCoconut *bool
}

// BundleMeta is returned by the /api/bundle/meta endpoint.
type BundleMeta struct {
	Count           int       `json:"count"`
	SizeBytes       int       `json:"size_bytes"`
	CompressedBytes int       `json:"compressed_bytes"`
	UpdatedAt       time.Time `json:"updated_at"`
	BaseURL         string    `json:"base_url"`
}

// PreparedProduct is the interface expected from the ingest package.
type PreparedProduct struct {
	Code            string
	Name            string
	ContainsCoconut *bool
}

// Cache holds an in-memory SKU lookup map and the pre-built gzipped bundle.
type Cache struct {
	mu              sync.RWMutex
	entries         map[string]*Entry
	gzippedBlob     []byte
	uncompressedLen int
	updatedAt       time.Time
}

const offBaseURL = "https://world.openfoodfacts.org/product/"

// Bundle format (gzipped TSV):
//
//	base_url\thttps://world.openfoodfacts.org/product/
//	updated_at\t2026-03-25T00:00:00Z
//	count\t864622
//	---
//	0012345678905\tSweet Lychee Peppermint\ty
//	0099887766554\tAnother Product\tn
//	0011223344556\tNo Ingredients Yet\t?
//
// Status: y=coconut, n=no coconut, ?=unknown

func coconutChar(c *bool) byte {
	if c == nil {
		return '?'
	}
	if *c {
		return 'y'
	}
	return 'n'
}

func parseCoconutChar(b byte) *bool {
	switch b {
	case 'y':
		v := true
		return &v
	case 'n':
		v := false
		return &v
	default:
		return nil
	}
}

// sanitizeName replaces tabs and newlines with spaces for TSV safety.
func sanitizeName(s string) string {
	s = strings.ReplaceAll(s, "\t", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", "")
	return s
}

// Build creates a Cache from a slice of prepared products.
func Build(products []PreparedProduct) (*Cache, error) {
	entries := make(map[string]*Entry, len(products))
	now := time.Now().UTC()

	// Build TSV
	var raw bytes.Buffer
	fmt.Fprintf(&raw, "base_url\t%s\n", offBaseURL)
	fmt.Fprintf(&raw, "updated_at\t%s\n", now.Format(time.RFC3339))
	fmt.Fprintf(&raw, "count\t%d\n", len(products))
	raw.WriteString("---\n")

	for _, p := range products {
		entries[p.Code] = &Entry{
			SKU:             p.Code,
			Name:            p.Name,
			ContainsCoconut: p.ContainsCoconut,
		}
		fmt.Fprintf(&raw, "%s\t%s\t%c\n", p.Code, sanitizeName(p.Name), coconutChar(p.ContainsCoconut))
	}

	uncompressedLen := raw.Len()

	var buf bytes.Buffer
	gz, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, fmt.Errorf("creating gzip writer: %w", err)
	}
	if _, err := gz.Write(raw.Bytes()); err != nil {
		return nil, fmt.Errorf("writing gzip: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, fmt.Errorf("closing gzip: %w", err)
	}

	log.Printf("Cache built: %d entries, %.1f MB TSV, %.1f MB gzipped (%.0f%% reduction)",
		len(entries),
		float64(uncompressedLen)/1024/1024,
		float64(buf.Len())/1024/1024,
		100-float64(buf.Len())*100/float64(uncompressedLen))

	return &Cache{
		entries:         entries,
		gzippedBlob:     buf.Bytes(),
		uncompressedLen: uncompressedLen,
		updatedAt:       now,
	}, nil
}

// WriteFile atomically writes the gzipped bundle to disk.
func (c *Cache) WriteFile(path string) error {
	c.mu.RLock()
	data := c.gzippedBlob
	c.mu.RUnlock()

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return fmt.Errorf("writing cache file: %w", err)
	}
	return os.Rename(tmp, path)
}

// LoadFile reads a gzipped TSV bundle from disk and populates the cache.
func LoadFile(path string) (*Cache, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reading cache file: %w", err)
	}

	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("opening gzip: %w", err)
	}
	defer gz.Close()

	scanner := bufio.NewScanner(gz)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	var updatedAt time.Time
	var count int
	inHeader := true

	entries := make(map[string]*Entry)

	for scanner.Scan() {
		line := scanner.Text()

		if inHeader {
			if line == "---" {
				inHeader = false
				if count > 0 {
					entries = make(map[string]*Entry, count)
				}
				continue
			}
			parts := strings.SplitN(line, "\t", 2)
			if len(parts) != 2 {
				continue
			}
			switch parts[0] {
			case "updated_at":
				updatedAt, _ = time.Parse(time.RFC3339, parts[1])
			case "count":
				count, _ = strconv.Atoi(parts[1])
			}
			continue
		}

		// Data line: sku\tname\tstatus
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) != 3 || len(parts[2]) == 0 {
			continue
		}

		entries[parts[0]] = &Entry{
			SKU:             parts[0],
			Name:            parts[1],
			ContainsCoconut: parseCoconutChar(parts[2][0]),
		}
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scanning bundle: %w", err)
	}

	// Compute uncompressed size from the raw data
	ungz, _ := gzip.NewReader(bytes.NewReader(data))
	var rawBuf bytes.Buffer
	rawBuf.ReadFrom(ungz)
	ungz.Close()

	log.Printf("Cache loaded from disk: %d entries, %.1f MB compressed", len(entries), float64(len(data))/1024/1024)

	return &Cache{
		entries:         entries,
		gzippedBlob:     data,
		uncompressedLen: rawBuf.Len(),
		updatedAt:       updatedAt,
	}, nil
}

// Lookup returns a single entry by SKU, or nil if not found.
func (c *Cache) Lookup(sku string) *Entry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.entries[sku]
}

// LookupBatch returns entries for the given SKUs. Missing SKUs are omitted.
func (c *Cache) LookupBatch(skus []string) map[string]*Entry {
	c.mu.RLock()
	defer c.mu.RUnlock()

	results := make(map[string]*Entry, len(skus))
	for _, sku := range skus {
		if e, ok := c.entries[sku]; ok {
			results[sku] = e
		}
	}
	return results
}

// ServeBundle writes the gzipped blob as an HTTP response.
func (c *Cache) ServeBundle(w http.ResponseWriter) {
	c.mu.RLock()
	blob := c.gzippedBlob
	updated := c.updatedAt
	c.mu.RUnlock()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.Itoa(len(blob)))
	w.Header().Set("Last-Modified", updated.UTC().Format(http.TimeFormat))
	w.Write(blob)
}

// Meta returns bundle metadata.
func (c *Cache) Meta() BundleMeta {
	c.mu.RLock()
	defer c.mu.RUnlock()

	return BundleMeta{
		Count:           len(c.entries),
		SizeBytes:       c.uncompressedLen,
		CompressedBytes: len(c.gzippedBlob),
		UpdatedAt:       c.updatedAt,
		BaseURL:         offBaseURL,
	}
}

// Count returns the number of entries.
func (c *Cache) Count() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}
