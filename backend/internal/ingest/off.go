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
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/marcboeker/go-duckdb"

	"github.com/hecate/coconutfree/internal/coconut"
)

const (
	parquetURL  = "https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet"
	defaultDir  = "/data"
)

type offProduct struct {
	Code           string
	ProductName    string
	Brands         string
	IngredientsText string
	ImageURL       string
	CategoriesTags string // comma-separated or DuckDB list as string
}

// RunOFF downloads the Open Food Facts parquet file (if needed) and ingests
// US frozen dessert products into the database.
func RunOFF(ctx context.Context, pool *pgxpool.Pool, dataDir string) error {
	if dataDir == "" {
		dataDir = defaultDir
	}

	parquetPath := filepath.Join(dataDir, "food.parquet")

	// Download if missing or stale (older than 24h)
	if needsDownload(parquetPath) {
		log.Println("Downloading Open Food Facts parquet file...")
		if err := downloadParquet(parquetPath); err != nil {
			return fmt.Errorf("downloading parquet: %w", err)
		}
		log.Println("Download complete")
	} else {
		log.Println("Using existing parquet file (less than 24h old)")
	}

	// Query with DuckDB
	log.Println("Querying parquet for US frozen desserts...")
	products, err := queryParquet(parquetPath)
	if err != nil {
		return fmt.Errorf("querying parquet: %w", err)
	}
	log.Printf("Found %d products", len(products))

	// Upsert into Postgres
	log.Println("Upserting into database...")
	stats, err := upsertProducts(ctx, pool, products)
	if err != nil {
		return fmt.Errorf("upserting products: %w", err)
	}

	log.Printf("Done: %d inserted, %d updated, %d unchanged", stats.inserted, stats.updated, stats.unchanged)
	return nil
}

func needsDownload(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return true
	}
	return time.Since(info.ModTime()) > 24*time.Hour
}

func downloadParquet(dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return err
	}

	tmpPath := dest + ".tmp"
	out, err := os.Create(tmpPath)
	if err != nil {
		return err
	}
	defer out.Close()

	req, err := http.NewRequest("GET", parquetURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "CoconutFree/1.0 (github.com/hecate/coconutfree)")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	size, err := io.Copy(out, resp.Body)
	if err != nil {
		os.Remove(tmpPath)
		return err
	}

	log.Printf("Downloaded %.1f MB", float64(size)/1024/1024)

	return os.Rename(tmpPath, dest)
}

func queryParquet(path string) ([]offProduct, error) {
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

	// Helper: build a CAST expression that coerces any column to a VARCHAR string
	toStr := func(col string) string {
		typ := colTypes[col]
		if strings.Contains(strings.ToUpper(typ), "LIST") || strings.Contains(strings.ToUpper(typ), "[]") {
			// List type — join elements into comma-separated string
			return fmt.Sprintf("COALESCE(array_to_string(%s, ', '), '')", col)
		}
		// Scalar — just coalesce to empty string
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

	query := fmt.Sprintf(`
		SELECT
			CAST(code AS VARCHAR) AS code,
			%s AS product_name,
			%s AS brands,
			%s AS ingredients_text,
			%s AS img_url,
			%s AS cats
		FROM '%s'
		WHERE list_contains(countries_tags, 'en:united-states')
			AND (
				list_contains(categories_tags, 'en:ice-creams-and-sorbets')
				OR list_contains(categories_tags, 'en:frozen-desserts')
				OR list_contains(categories_tags, 'en:ice-creams')
				OR list_contains(categories_tags, 'en:sorbets')
				OR list_contains(categories_tags, 'en:gelati')
				OR list_contains(categories_tags, 'en:frozen-yogurts')
				OR list_contains(categories_tags, 'en:ice-cream-bars')
				OR list_contains(categories_tags, 'en:ice-cream-sandwiches')
				OR list_contains(categories_tags, 'en:ice-cream-tubs')
				OR list_contains(categories_tags, 'en:popsicles')
			)
			AND code IS NOT NULL
			AND CAST(code AS VARCHAR) != ''
	`, toStr("product_name"), toStr("brands"), toStr("ingredients_text"), imgExpr, toStr("categories_tags"), path)

	rows, err := db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("querying: %w", err)
	}
	defer rows.Close()

	var products []offProduct
	for rows.Next() {
		var p offProduct
		if err := rows.Scan(&p.Code, &p.ProductName, &p.Brands, &p.IngredientsText, &p.ImageURL, &p.CategoriesTags); err != nil {
			return nil, fmt.Errorf("scanning row: %w", err)
		}
		products = append(products, p)
	}

	return products, rows.Err()
}

type upsertStats struct {
	inserted  int
	updated   int
	unchanged int
}

func upsertProducts(ctx context.Context, pool *pgxpool.Pool, products []offProduct) (upsertStats, error) {
	var stats upsertStats
	now := time.Now()

	for _, p := range products {
		if p.Code == "" || (p.ProductName == "" && p.Brands == "") {
			continue
		}

		category := classifyCategory(p.CategoriesTags)
		coconutFound := coconut.Detect(p.IngredientsText)
		hasIngredients := strings.TrimSpace(p.IngredientsText) != ""

		// Determine coconut status:
		// - If ingredients present and coconut found -> true
		// - If ingredients present and no coconut -> false
		// - If no ingredients text -> NULL (unknown)
		var containsCoconut *bool
		if hasIngredients {
			containsCoconut = &coconutFound
		}

		var imageURL *string
		if p.ImageURL != "" {
			imageURL = &p.ImageURL
		}

		brand := p.Brands
		if brand == "" {
			brand = "Unknown"
		}
		name := p.ProductName
		if name == "" {
			name = "Unknown Product"
		}

		// Check if product exists
		var existingID uuid.UUID
		var existingCoconut *bool
		err := pool.QueryRow(ctx,
			"SELECT id, contains_coconut FROM products WHERE sku = $1", p.Code,
		).Scan(&existingID, &existingCoconut)

		if err != nil {
			// Product doesn't exist — insert
			id := uuid.New()
			_, err = pool.Exec(ctx, `
				INSERT INTO products (id, sku, brand, name, category, image_url, contains_coconut, status_as_of, created_at, updated_at)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
			`, id, p.Code, brand, name, category, imageURL, containsCoconut, now, now)
			if err != nil {
				return stats, fmt.Errorf("inserting product %s: %w", p.Code, err)
			}

			// Add ingredient source
			if hasIngredients {
				_, err = pool.Exec(ctx, `
					INSERT INTO ingredient_sources (id, product_id, source_type, source_url, ingredients_raw, coconut_found, confidence, fetched_at, created_at)
					VALUES ($1, $2, 'openfoodfacts', 'https://world.openfoodfacts.org/product/' || $3, $4, $5, 'medium', $6, $6)
				`, uuid.New(), id, p.Code, p.IngredientsText, coconutFound, now)
				if err != nil {
					return stats, fmt.Errorf("inserting source for %s: %w", p.Code, err)
				}
			}

			stats.inserted++
		} else {
			// Product exists — check if status changed
			// But DON'T override user flags: if a user flagged coconut, keep it
			var hasUserCoconutFlag bool
			pool.QueryRow(ctx,
				"SELECT EXISTS(SELECT 1 FROM user_flags WHERE product_id = $1 AND flag_type = 'found_coconut' AND resolved = false)",
				existingID,
			).Scan(&hasUserCoconutFlag)

			if hasUserCoconutFlag {
				// User flag takes priority — don't update coconut status
				stats.unchanged++
				continue
			}

			statusChanged := !boolPtrEqual(existingCoconut, containsCoconut)

			if statusChanged {
				// Log the change
				_, err = pool.Exec(ctx, `
					INSERT INTO status_changelog (id, product_id, old_contains_coconut, new_contains_coconut, reason, changed_at)
					VALUES ($1, $2, $3, $4, $5, $6)
				`, uuid.New(), existingID, existingCoconut, containsCoconut, "Open Food Facts data update", now)
				if err != nil {
					return stats, fmt.Errorf("logging change for %s: %w", p.Code, err)
				}
			}

			// Update product
			_, err = pool.Exec(ctx, `
				UPDATE products SET brand = $1, name = $2, category = $3, image_url = $4,
					contains_coconut = $5, status_as_of = $6, updated_at = $6
				WHERE id = $7
			`, brand, name, category, imageURL, containsCoconut, now, existingID)
			if err != nil {
				return stats, fmt.Errorf("updating product %s: %w", p.Code, err)
			}

			// Upsert ingredient source
			if hasIngredients {
				_, err = pool.Exec(ctx, `
					INSERT INTO ingredient_sources (id, product_id, source_type, source_url, ingredients_raw, coconut_found, confidence, fetched_at, created_at)
					VALUES ($1, $2, 'openfoodfacts', 'https://world.openfoodfacts.org/product/' || $3, $4, $5, 'medium', $6, $6)
					ON CONFLICT DO NOTHING
				`, uuid.New(), existingID, p.Code, p.IngredientsText, coconutFound, now)
				if err != nil {
					return stats, fmt.Errorf("upserting source for %s: %w", p.Code, err)
				}
			}

			if statusChanged {
				stats.updated++
			} else {
				stats.unchanged++
			}
		}
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
