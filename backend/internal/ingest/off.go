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
	"sync/atomic"
	"time"

	_ "github.com/marcboeker/go-duckdb"

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
	cachePath := filepath.Join(dataDir, "skus.tsv.gz")

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

	hasStruct := func(typ string) bool {
		upper := strings.ToUpper(typ)
		return strings.Contains(upper, "STRUCT")
	}
	isList := func(typ string) bool {
		upper := strings.ToUpper(typ)
		return strings.Contains(upper, "LIST") || strings.Contains(upper, "[]")
	}

	// Extract text from a LIST(STRUCT(lang, text)) — use lang 'main'
	extractLangText := func(col string) string {
		return fmt.Sprintf(`COALESCE(
			(SELECT s.text FROM UNNEST(%s) AS t(s) WHERE s.lang = 'main' LIMIT 1),
			''
		)`, col)
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
		if hasStruct(typ) {
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
			if hasStruct(typ) {
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

// PreparedProduct holds pre-computed fields ready for cache building.
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

