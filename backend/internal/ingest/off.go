package ingest

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/marcboeker/go-duckdb"
	"golang.org/x/sync/errgroup"

	"github.com/hecate/coconutfree/internal/coconut"
)

// ProgressFunc is called to report ingestion progress.
type ProgressFunc func(phase string, current, total int64)

const (
	parquetURL  = "https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet"
	defaultDir  = "/data"
)

type offProduct struct {
	Code            string
	ProductName     string
	Brands          string
	IngredientsText string // preferred (EN), used for display + storage
	IngredientsAll  string // all languages concatenated, used for coconut detection
	ImageURL        string
	CategoriesTags  string // comma-separated
}

// NeedsIngest reports whether the parquet file is missing or stale AND the
// cache file is also missing or older than the parquet. Returns false when
// there's nothing new to process.
func NeedsIngest(dataDir string) bool {
	if dataDir == "" {
		dataDir = defaultDir
	}
	parquetPath := filepath.Join(dataDir, "food.parquet")
	cachePath := filepath.Join(dataDir, "skus.json.gz")

	// No parquet at all → need to download + ingest
	pInfo, err := os.Stat(parquetPath)
	if err != nil {
		return true
	}

	// Cache missing → need to process the parquet we have
	cInfo, err := os.Stat(cachePath)
	if err != nil {
		return true
	}

	// Cache is older than parquet → stale, re-process
	if cInfo.ModTime().Before(pInfo.ModTime()) {
		return true
	}

	// Parquet is stale (>24h) → need fresh download
	if time.Since(pInfo.ModTime()) > 24*time.Hour {
		return true
	}

	return false
}

// RunOFF downloads the Open Food Facts parquet file (if needed), queries it,
// and returns prepared products. Country filter is configurable via INGEST_COUNTRIES.
// The caller is responsible for building the cache and upserting into the database.
func RunOFF(ctx context.Context, dataDir string, onProgress ProgressFunc) ([]PreparedProduct, error) {
	if onProgress == nil {
		onProgress = func(string, int64, int64) {}
	}
	if dataDir == "" {
		dataDir = defaultDir
	}

	parquetPath := filepath.Join(dataDir, "food.parquet")

	// Download if missing or stale (older than 24h)
	if needsDownload(parquetPath) {
		log.Println("Downloading Open Food Facts parquet file...")
		onProgress("downloading", 0, 0)
		if err := downloadParquet(ctx, parquetPath, onProgress); err != nil {
			return nil, fmt.Errorf("downloading parquet: %w", err)
		}
		log.Println("Download complete")
	}

	// Query with DuckDB
	country := os.Getenv("INGEST_COUNTRIES")
	if country == "" {
		country = "en:united-states"
	}
	if country == "-" {
		country = "" // explicit empty = all countries
	}
	if country != "" {
		log.Printf("Querying parquet for products (country: %s)...", country)
	} else {
		log.Println("Querying parquet for all products (no country filter)...")
	}
	onProgress("querying", 0, 0)
	products, err := queryParquet(parquetPath, country)
	if err != nil {
		return nil, fmt.Errorf("querying parquet: %w", err)
	}
	log.Printf("Found %d products", len(products))
	onProgress("querying", int64(len(products)), int64(len(products)))

	// Pre-compute all product data
	log.Println("Pre-computing product data...")
	prepared := PrepareProducts(products)
	log.Printf("Prepared %d valid products (deduped from %d)", len(prepared), len(products))

	return prepared, nil
}

// UpsertProducts writes prepared products into the database.
func UpsertProducts(ctx context.Context, pool *pgxpool.Pool, prepared []PreparedProduct, onProgress ProgressFunc) error {
	if onProgress == nil {
		onProgress = func(string, int64, int64) {}
	}

	log.Println("Upserting into database...")
	stats, err := upsertProducts(ctx, pool, prepared, onProgress)
	if err != nil {
		return fmt.Errorf("upserting products: %w", err)
	}

	log.Printf("Done: %d inserted, %d updated (status change), %d refreshed, %d skipped (user-flagged)",
		stats.inserted, stats.updated, stats.refreshed, stats.unchanged)
	return nil
}

func needsDownload(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return true
	}
	return time.Since(info.ModTime()) > 24*time.Hour
}

// countingReader wraps an io.Reader and reports progress.
type countingReader struct {
	reader     io.Reader
	total      int64
	read       atomic.Int64
	onProgress ProgressFunc
	lastReport int64
}

func (cr *countingReader) Read(p []byte) (int, error) {
	n, err := cr.reader.Read(p)
	if n > 0 {
		current := cr.read.Add(int64(n))
		// Report every ~512KB
		if current-cr.lastReport >= 512*1024 || err == io.EOF {
			cr.lastReport = current
			cr.onProgress("downloading", current, cr.total)
		}
	}
	return n, err
}

func downloadParquet(ctx context.Context, dest string, onProgress ProgressFunc) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}

	tmpPath := dest + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		return err
	}
	defer out.Close()

	req, err := http.NewRequestWithContext(ctx, "GET", parquetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "CocoNot/1.0 (github.com/pandorasfox/coconot)")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var total int64
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		total, _ = strconv.ParseInt(cl, 10, 64)
	}

	cr := &countingReader{reader: resp.Body, total: total, onProgress: onProgress}
	size, err := io.Copy(out, cr)
	if err != nil {
		os.Remove(tmpPath)
		return err
	}

	onProgress("downloading", size, size)
	log.Printf("Downloaded %.1f MB", float64(size)/1024/1024)

	return os.Rename(tmpPath, dest)
}

func queryParquet(path string, country string) ([]offProduct, error) {
	db, err := sql.Open("duckdb", "")
	if err != nil {
		return nil, fmt.Errorf("opening duckdb: %w", err)
	}
	defer db.Close()

	// Discover schema — the parquet file uses a mix of VARCHAR and LIST types
	// that vary across versions. Log it for debugging and build the query dynamically.
	colTypes := map[string]string{}
	schemaRows, err := db.Query(fmt.Sprintf("SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM '%s' LIMIT 0)", path))
	if err != nil {
		return nil, fmt.Errorf("reading schema: %w", err)
	}
	for schemaRows.Next() {
		var name, typ string
		schemaRows.Scan(&name, &typ)
		colTypes[name] = typ
	}
	schemaRows.Close()

	log.Printf("Parquet schema sample: product_name=%s, brands=%s, ingredients_text=%s, categories_tags=%s",
		colTypes["product_name"], colTypes["brands"], colTypes["ingredients_text"], colTypes["categories_tags"])
	log.Printf("Image columns: image_url=%s, image_front_url=%s, image_front_small_url=%s",
		colTypes["image_url"], colTypes["image_front_url"], colTypes["image_front_small_url"])

	// Log all columns containing 'image' for discovery
	for col, typ := range colTypes {
		if strings.Contains(strings.ToLower(col), "image") {
			log.Printf("  image col: %s = %s", col, typ)
		}
	}

	isStructList := func(typ string) bool {
		upper := strings.ToUpper(typ)
		return strings.Contains(upper, "STRUCT") && strings.Contains(upper, "LIST")
	}
	isList := func(typ string) bool {
		upper := strings.ToUpper(typ)
		return strings.Contains(upper, "LIST") || strings.Contains(upper, "[]")
	}

	// Extract text from a LIST(STRUCT(lang, text)) — prefer 'en', then 'main', then first entry
	extractLangText := func(col string) string {
		return fmt.Sprintf(`COALESCE(
			(SELECT s.text FROM UNNEST(%s) AS t(s) WHERE s.lang = 'en' LIMIT 1),
			(SELECT s.text FROM UNNEST(%s) AS t(s) WHERE s.lang = 'main' LIMIT 1),
			(SELECT s.text FROM UNNEST(%s) AS t(s) LIMIT 1),
			''
		)`, col, col, col)
	}

	// Extract ALL text entries from a LIST(STRUCT(lang, text)) — for coconut detection
	extractAllText := func(col string) string {
		return fmt.Sprintf(`COALESCE(
			(SELECT string_agg(s.text, ' ') FROM UNNEST(%s) AS t(s)),
			''
		)`, col)
	}

	// Coerce any column to a scalar string
	toStr := func(col string) string {
		typ := colTypes[col]
		if isStructList(typ) {
			return extractLangText(col)
		}
		if isList(typ) {
			return fmt.Sprintf("COALESCE(array_to_string(%s, ', '), '')", col)
		}
		return fmt.Sprintf("COALESCE(CAST(%s AS VARCHAR), '')", col)
	}

	// Find best image column
	imgExpr := "''"
	for _, candidate := range []string{"image_front_url", "image_front_small_url", "image_url"} {
		if _, ok := colTypes[candidate]; ok {
			imgExpr = toStr(candidate)
			break
		}
	}

	// Ingredients: prefer ingredients_text_en, fall back to ingredients_text
	ingredientsExpr := "''"
	for _, candidate := range []string{"ingredients_text_en", "ingredients_text"} {
		if _, ok := colTypes[candidate]; ok {
			ingredientsExpr = toStr(candidate)
			break
		}
	}

	// For coconut detection: concat ALL text from ALL ingredients_text* columns
	var ingredientsCols []string
	for col, typ := range colTypes {
		if strings.HasPrefix(col, "ingredients_text") {
			if isStructList(typ) {
				ingredientsCols = append(ingredientsCols, extractAllText(col))
			} else if isList(typ) {
				ingredientsCols = append(ingredientsCols, fmt.Sprintf("COALESCE(array_to_string(%s, ' '), '')", col))
			} else {
				ingredientsCols = append(ingredientsCols, fmt.Sprintf("COALESCE(CAST(%s AS VARCHAR), '')", col))
			}
		}
	}
	ingredientsAllExpr := "''"
	if len(ingredientsCols) > 0 {
		ingredientsAllExpr = "CONCAT_WS(' ', " + strings.Join(ingredientsCols, ", ") + ")"
	}

	countryFilter := ""
	if country != "" {
		countryFilter = fmt.Sprintf("AND list_contains(countries_tags, '%s')", country)
	}

	query := fmt.Sprintf(`
		SELECT
			CAST(code AS VARCHAR) AS code,
			%s AS product_name,
			%s AS brands,
			%s AS ingredients_text,
			%s AS ingredients_all,
			%s AS img_url,
			%s AS cats
		FROM '%s'
		WHERE code IS NOT NULL
			AND CAST(code AS VARCHAR) != ''
			%s
	`, toStr("product_name"), toStr("brands"), ingredientsExpr, ingredientsAllExpr, imgExpr, toStr("categories_tags"), path, countryFilter)

	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("querying: %w", err)
	}
	defer rows.Close()

	var products []offProduct
	for rows.Next() {
		var p offProduct
		if err := rows.Scan(&p.Code, &p.ProductName, &p.Brands, &p.IngredientsText, &p.IngredientsAll, &p.ImageURL, &p.CategoriesTags); err != nil {
			return nil, fmt.Errorf("scanning row: %w", err)
		}
		products = append(products, p)
	}

	// Debug: log first 5 image URLs to diagnose parquet extraction
	for i, p := range products {
		if i >= 5 {
			break
		}
		log.Printf("  sample[%d] sku=%s img=%q", i, p.Code, p.ImageURL)
	}

	return products, rows.Err()
}

type upsertStats struct {
	inserted  int
	updated   int // coconut status changed
	refreshed int // data refreshed, coconut status same
	unchanged int // user-flagged, completely skipped
}

const (
	upsertChunkSize = 1000
	upsertWorkers   = 8
)

// PreparedProduct holds pre-computed fields ready for DB upsert and cache building.
type PreparedProduct struct {
	Code            string
	Brand           string
	Name            string
	Category        string
	IngredientsText string
	ImageURL        *string
	CoconutFound    bool
	HasIngredients  bool
	ContainsCoconut *bool
}

// PrepareProducts pre-computes coconut detection, classification, and field
// normalization for all products. Filters out invalid entries and deduplicates
// by SKU (keeps last occurrence).
func PrepareProducts(products []offProduct) []PreparedProduct {
	// Deduplicate by SKU — keep last occurrence (matches old sequential behavior)
	seen := make(map[string]int, len(products))
	for i, p := range products {
		if p.Code == "" || (p.ProductName == "" && p.Brands == "") {
			continue
		}
		seen[p.Code] = i
	}

	result := make([]PreparedProduct, 0, len(seen))
	for _, idx := range seen {
		p := products[idx]

		brand := p.Brands
		if brand == "" {
			brand = "Unknown"
		}
		name := p.ProductName
		if name == "" {
			name = "Unknown Product"
		}

		coconutFound := coconut.Detect(p.IngredientsAll)
		hasIngredients := strings.TrimSpace(p.IngredientsText) != "" || strings.TrimSpace(p.IngredientsAll) != ""

		var containsCoconut *bool
		if hasIngredients {
			containsCoconut = &coconutFound
		}

		var imageURL *string
		if p.ImageURL != "" {
			imageURL = &p.ImageURL
		}

		result = append(result, PreparedProduct{
			Code:            p.Code,
			Brand:           brand,
			Name:            name,
			Category:        classifyCategory(p.CategoriesTags),
			IngredientsText: p.IngredientsText,
			ImageURL:        imageURL,
			CoconutFound:    coconutFound,
			HasIngredients:  hasIngredients,
			ContainsCoconut: containsCoconut,
		})
	}
	return result
}

func upsertProducts(ctx context.Context, pool *pgxpool.Pool, prepared []PreparedProduct, onProgress ProgressFunc) (upsertStats, error) {
	total := int64(len(prepared))

	// Phase 2: Chunk and fan out to worker pool
	var (
		mu        sync.Mutex
		stats     upsertStats
		processed atomic.Int64
	)
	now := time.Now()

	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(upsertWorkers)

	for i := 0; i < len(prepared); i += upsertChunkSize {
		end := i + upsertChunkSize
		if end > len(prepared) {
			end = len(prepared)
		}
		chunk := prepared[i:end]

		g.Go(func() error {
			s, err := processChunk(gctx, pool, chunk, now)
			if err != nil {
				return err
			}

			mu.Lock()
			stats.inserted += s.inserted
			stats.updated += s.updated
			stats.refreshed += s.refreshed
			stats.unchanged += s.unchanged
			mu.Unlock()

			cur := processed.Add(int64(len(chunk)))
			onProgress("upserting", cur, total)
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return stats, err
	}

	onProgress("upserting", total, total)
	return stats, nil
}

type existingProduct struct {
	id              uuid.UUID
	containsCoconut *bool
}

// processChunk handles a batch of products: bulk-reads existing state, then
// pipelines all writes through a single pgx.Batch inside a transaction.
func processChunk(ctx context.Context, pool *pgxpool.Pool, chunk []PreparedProduct, now time.Time) (upsertStats, error) {
	var stats upsertStats

	tx, err := pool.Begin(ctx)
	if err != nil {
		return stats, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback(ctx)

	// Bulk lookup existing products by SKU
	skus := make([]string, len(chunk))
	for i, p := range chunk {
		skus[i] = p.Code
	}

	existing := make(map[string]existingProduct, len(chunk))
	rows, err := tx.Query(ctx, "SELECT sku, id, contains_coconut FROM products WHERE sku = ANY($1)", skus)
	if err != nil {
		return stats, fmt.Errorf("bulk lookup: %w", err)
	}
	for rows.Next() {
		var sku string
		var ep existingProduct
		if err := rows.Scan(&sku, &ep.id, &ep.containsCoconut); err != nil {
			rows.Close()
			return stats, fmt.Errorf("scanning existing: %w", err)
		}
		existing[sku] = ep
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return stats, fmt.Errorf("bulk lookup rows: %w", err)
	}

	// Bulk lookup user flags for existing products
	flagged := make(map[uuid.UUID]bool)
	if len(existing) > 0 {
		ids := make([]uuid.UUID, 0, len(existing))
		for _, ep := range existing {
			ids = append(ids, ep.id)
		}

		flagRows, err := tx.Query(ctx,
			"SELECT DISTINCT product_id FROM user_flags WHERE product_id = ANY($1) AND flag_type = 'found_coconut' AND resolved = false",
			ids,
		)
		if err != nil {
			return stats, fmt.Errorf("bulk flag lookup: %w", err)
		}
		for flagRows.Next() {
			var pid uuid.UUID
			if err := flagRows.Scan(&pid); err != nil {
				flagRows.Close()
				return stats, fmt.Errorf("scanning flag: %w", err)
			}
			flagged[pid] = true
		}
		flagRows.Close()
	}

	// Build pipelined batch of all writes
	batch := &pgx.Batch{}

	for _, p := range chunk {
		if ep, ok := existing[p.Code]; ok {
			// Existing product — respect user flags
			if flagged[ep.id] {
				stats.unchanged++
				continue
			}

			statusChanged := !boolPtrEqual(ep.containsCoconut, p.ContainsCoconut)
			if statusChanged {
				batch.Queue(`
					INSERT INTO status_changelog (id, product_id, old_contains_coconut, new_contains_coconut, reason, changed_at)
					VALUES ($1, $2, $3, $4, $5, $6)
				`, uuid.New(), ep.id, ep.containsCoconut, p.ContainsCoconut, "Open Food Facts data update", now)
				stats.updated++
			} else {
				stats.refreshed++
			}

			batch.Queue(`
				UPDATE products SET brand = $1, name = $2, category = $3, image_url = $4,
					contains_coconut = $5, status_as_of = $6, updated_at = $6
				WHERE id = $7
			`, p.Brand, p.Name, p.Category, p.ImageURL, p.ContainsCoconut, now, ep.id)

			if p.HasIngredients {
				batch.Queue(`
					INSERT INTO ingredient_sources (id, product_id, source_type, source_url, ingredients_raw, coconut_found, fetched_at, created_at)
					VALUES ($1, $2, 'openfoodfacts', 'https://world.openfoodfacts.org/product/' || $3, $4, $5, $6, $6)
					ON CONFLICT (product_id, source_type) DO UPDATE SET
						ingredients_raw = EXCLUDED.ingredients_raw,
						coconut_found = EXCLUDED.coconut_found,
						fetched_at = EXCLUDED.fetched_at
				`, uuid.New(), ep.id, p.Code, p.IngredientsText, p.CoconutFound, now)
			}
		} else {
			// New product — insert
			id := uuid.New()
			batch.Queue(`
				INSERT INTO products (id, sku, brand, name, category, image_url, contains_coconut, status_as_of, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
			`, id, p.Code, p.Brand, p.Name, p.Category, p.ImageURL, p.ContainsCoconut, now, now)

			if p.HasIngredients {
				batch.Queue(`
					INSERT INTO ingredient_sources (id, product_id, source_type, source_url, ingredients_raw, coconut_found, fetched_at, created_at)
					VALUES ($1, $2, 'openfoodfacts', 'https://world.openfoodfacts.org/product/' || $3, $4, $5, $6, $6)
					ON CONFLICT (product_id, source_type) DO UPDATE SET
						ingredients_raw = EXCLUDED.ingredients_raw,
						coconut_found = EXCLUDED.coconut_found,
						fetched_at = EXCLUDED.fetched_at
				`, uuid.New(), id, p.Code, p.IngredientsText, p.CoconutFound, now)
			}

			stats.inserted++
		}
	}

	// Execute all writes in one pipelined round-trip
	if batch.Len() > 0 {
		br := tx.SendBatch(ctx, batch)
		for i := 0; i < batch.Len(); i++ {
			if _, err := br.Exec(); err != nil {
				br.Close()
				return stats, fmt.Errorf("batch exec (query %d/%d): %w", i+1, batch.Len(), err)
			}
		}
		br.Close()
	}

	if err := tx.Commit(ctx); err != nil {
		return stats, fmt.Errorf("commit: %w", err)
	}

	return stats, nil
}

func classifyCategory(tags string) string {
	lower := strings.ToLower(tags)
	switch {
	case strings.Contains(lower, "sorbet"):
		return "sorbet"
	case strings.Contains(lower, "gelat"):
		return "gelato"
	case strings.Contains(lower, "frozen-yogurt"):
		return "frozen_yogurt"
	case strings.Contains(lower, "popsicle") || strings.Contains(lower, "ice-cream-bar"):
		return "novelty"
	case strings.Contains(lower, "ice-cream"):
		return "ice_cream"
	default:
		return "other"
	}
}

func boolPtrEqual(a, b *bool) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
