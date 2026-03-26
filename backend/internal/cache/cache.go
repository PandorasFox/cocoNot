package cache

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
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
}

// bundleProduct is the compact JSON representation within the bundle.
type bundleProduct struct {
	SKU     string `json:"s"`
	Name    string `json:"n"`
	Coconut *int8  `json:"c"` // 1=yes, 0=no, null=unknown
}

// bundleEnvelope is the top-level JSON structure of the bundle.
type bundleEnvelope struct {
	BaseURL   string          `json:"base_url"`
	UpdatedAt time.Time       `json:"updated_at"`
	Count     int             `json:"count"`
	Products  []bundleProduct `json:"products"`
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

// Build creates a Cache from a slice of prepared products.
func Build(products []PreparedProduct) (*Cache, error) {
	entries := make(map[string]*Entry, len(products))
	bps := make([]bundleProduct, 0, len(products))

	for _, p := range products {
		entries[p.Code] = &Entry{
			SKU:             p.Code,
			Name:            p.Name,
			ContainsCoconut: p.ContainsCoconut,
		}

		var c *int8
		if p.ContainsCoconut != nil {
			v := int8(0)
			if *p.ContainsCoconut {
				v = 1
			}
			c = &v
		}
		bps = append(bps, bundleProduct{
			SKU:     p.Code,
			Name:    p.Name,
			Coconut: c,
		})
	}

	env := bundleEnvelope{
		BaseURL:   offBaseURL,
		UpdatedAt: time.Now(),
		Count:     len(bps),
		Products:  bps,
	}

	jsonData, err := json.Marshal(env)
	if err != nil {
		return nil, fmt.Errorf("marshaling bundle: %w", err)
	}

	var buf bytes.Buffer
	gz, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, fmt.Errorf("creating gzip writer: %w", err)
	}
	if _, err := gz.Write(jsonData); err != nil {
		return nil, fmt.Errorf("writing gzip: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, fmt.Errorf("closing gzip: %w", err)
	}

	log.Printf("Cache built: %d entries, %d bytes JSON, %d bytes gzipped (%.1f%% compression)",
		len(entries), len(jsonData), buf.Len(), 100-float64(buf.Len())*100/float64(len(jsonData)))

	return &Cache{
		entries:         entries,
		gzippedBlob:     buf.Bytes(),
		uncompressedLen: len(jsonData),
		updatedAt:       env.UpdatedAt,
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

// LoadFile reads a gzipped bundle from disk and populates the cache.
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

	var env bundleEnvelope
	if err := json.NewDecoder(gz).Decode(&env); err != nil {
		return nil, fmt.Errorf("decoding bundle: %w", err)
	}

	entries := make(map[string]*Entry, len(env.Products))
	for _, bp := range env.Products {
		var cc *bool
		if bp.Coconut != nil {
			v := *bp.Coconut == 1
			cc = &v
		}
		entries[bp.SKU] = &Entry{
			SKU:             bp.SKU,
			Name:            bp.Name,
			ContainsCoconut: cc,
		}
	}

	// Re-marshal to get accurate uncompressed size
	jsonData, _ := json.Marshal(env)

	log.Printf("Cache loaded from disk: %d entries, %d bytes compressed", len(entries), len(data))

	return &Cache{
		entries:         entries,
		gzippedBlob:     data,
		uncompressedLen: len(jsonData),
		updatedAt:       env.UpdatedAt,
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

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Encoding", "gzip")
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
	}
}

// Count returns the number of entries.
func (c *Cache) Count() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return len(c.entries)
}
