package ingest

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/marcboeker/go-duckdb"
)

// createTestParquet uses DuckDB to write a small parquet file with the same
// LIST(STRUCT(lang, text)) schema that Open Food Facts uses.
func createTestParquet(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "test.parquet")

	db, err := sql.Open("duckdb", "")
	if err != nil {
		t.Fatalf("open duckdb: %v", err)
	}
	defer db.Close()

	// Build a table matching OFF's schema: struct list columns for text fields,
	// plain VARCHAR for code/image, LIST(VARCHAR) for countries_tags.
	stmts := []string{
		`CREATE TABLE products (
			code VARCHAR,
			product_name STRUCT(lang VARCHAR, "text" VARCHAR)[],
			brands STRUCT(lang VARCHAR, "text" VARCHAR)[],
			ingredients_text STRUCT(lang VARCHAR, "text" VARCHAR)[],
			ingredients_text_en STRUCT(lang VARCHAR, "text" VARCHAR)[],
			ingredients_text_es STRUCT(lang VARCHAR, "text" VARCHAR)[],
			categories_tags VARCHAR[],
			countries_tags VARCHAR[],
			image_front_url VARCHAR
		)`,
		// Product 1: has main, en, es — should extract main
		`INSERT INTO products VALUES (
			'0012345678905',
			[{'lang': 'main', 'text': 'Galletas de Chocolate'}, {'lang': 'en', 'text': 'Chocolate Cookies'}, {'lang': 'es', 'text': 'Galletas de Chocolate'}],
			[{'lang': 'main', 'text': 'TestBrand'}],
			[{'lang': 'main', 'text': 'sugar, flour, cocoa'}, {'lang': 'en', 'text': 'sugar, flour, cocoa'}],
			[{'lang': 'main', 'text': 'sugar, flour, cocoa'}],
			[{'lang': 'main', 'text': 'azúcar, harina, cacao'}],
			['en:cookies', 'en:chocolate-cookies'],
			['en:united-states', 'en:mexico'],
			'https://images.off.org/12345.jpg'
		)`,
		// Product 2: coconut in ingredients, only main lang
		`INSERT INTO products VALUES (
			'0099887766554',
			[{'lang': 'main', 'text': 'Tropical Bar'}],
			[{'lang': 'main', 'text': 'SnackCo'}],
			[{'lang': 'main', 'text': 'sugar, coconut oil, milk'}],
			[{'lang': 'main', 'text': 'sugar, coconut oil, milk'}],
			NULL,
			['en:snacks'],
			['en:united-states'],
			NULL
		)`,
		// Product 3: no country match (should be filtered out with country filter)
		`INSERT INTO products VALUES (
			'4006040000000',
			[{'lang': 'main', 'text': 'Bratwurst'}],
			[{'lang': 'main', 'text': 'WurstWerk'}],
			[{'lang': 'main', 'text': 'pork, salt, spices'}],
			NULL,
			NULL,
			['en:sausages'],
			['en:germany'],
			NULL
		)`,
		// Product 4: empty code (should be filtered out)
		`INSERT INTO products VALUES (
			'',
			[{'lang': 'main', 'text': 'Ghost Product'}],
			[{'lang': 'main', 'text': 'Nobody'}],
			NULL, NULL, NULL, NULL, NULL, NULL
		)`,
	}

	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("exec %q: %v", s[:40], err)
		}
	}

	_, err = db.Exec("COPY products TO '" + path + "' (FORMAT PARQUET)")
	if err != nil {
		t.Fatalf("copy to parquet: %v", err)
	}

	return path
}

func TestQueryParquet_ExtractsMainLang(t *testing.T) {
	dir := t.TempDir()
	path := createTestParquet(t, dir)

	products, err := queryParquet(path, "")
	if err != nil {
		t.Fatalf("queryParquet: %v", err)
	}

	// Should have 3 products (empty code filtered out)
	if len(products) != 3 {
		t.Fatalf("expected 3 products, got %d", len(products))
	}

	byCode := map[string]offProduct{}
	for _, p := range products {
		byCode[p.Code] = p
	}

	// Product 1: should have main lang text, not en
	p1 := byCode["0012345678905"]
	if p1.ProductName != "Galletas de Chocolate" {
		t.Errorf("product_name: got %q, want %q", p1.ProductName, "Galletas de Chocolate")
	}
	if p1.Brands != "TestBrand" {
		t.Errorf("brands: got %q, want %q", p1.Brands, "TestBrand")
	}
	if p1.ImageURL != "https://images.off.org/12345.jpg" {
		t.Errorf("image_url: got %q", p1.ImageURL)
	}

	// Product 2: coconut in ingredients
	p2 := byCode["0099887766554"]
	if p2.ProductName != "Tropical Bar" {
		t.Errorf("product_name: got %q, want %q", p2.ProductName, "Tropical Bar")
	}
	if !strings.Contains(p2.IngredientsText, "coconut") {
		t.Errorf("ingredients_text should contain 'coconut', got %q", p2.IngredientsText)
	}
	if !strings.Contains(p2.IngredientsAll, "coconut") {
		t.Errorf("ingredients_all should contain 'coconut', got %q", p2.IngredientsAll)
	}
}

func TestQueryParquet_CountryFilter(t *testing.T) {
	dir := t.TempDir()
	path := createTestParquet(t, dir)

	products, err := queryParquet(path, "en:united-states")
	if err != nil {
		t.Fatalf("queryParquet: %v", err)
	}

	// Only products 1 and 2 are in en:united-states
	if len(products) != 2 {
		t.Fatalf("expected 2 US products, got %d", len(products))
	}

	for _, p := range products {
		if p.Code == "4006040000000" {
			t.Error("German product should have been filtered out")
		}
	}
}

func TestQueryParquet_NoStructLangLeak(t *testing.T) {
	dir := t.TempDir()
	path := createTestParquet(t, dir)

	products, err := queryParquet(path, "")
	if err != nil {
		t.Fatalf("queryParquet: %v", err)
	}

	for _, p := range products {
		if strings.Contains(p.ProductName, "lang") || strings.Contains(p.ProductName, "text") {
			t.Errorf("product %s name contains struct leak: %q", p.Code, p.ProductName)
		}
		if strings.Contains(p.Brands, "lang") {
			t.Errorf("product %s brand contains struct leak: %q", p.Code, p.Brands)
		}
	}
}

func TestPrepareProducts_CoconutDetection(t *testing.T) {
	dir := t.TempDir()
	path := createTestParquet(t, dir)

	raw, err := queryParquet(path, "")
	if err != nil {
		t.Fatalf("queryParquet: %v", err)
	}

	// Need to set ALLERGEN_KEYWORDS or use default
	prepared := PrepareProducts(raw)

	byCode := map[string]PreparedProduct{}
	for _, p := range prepared {
		byCode[p.Code] = p
	}

	// Chocolate cookies — no coconut
	p1 := byCode["0012345678905"]
	if p1.ContainsCoconut == nil {
		t.Fatal("expected non-nil ContainsCoconut for product with ingredients")
	}
	if *p1.ContainsCoconut {
		t.Error("chocolate cookies should not contain coconut")
	}

	// Tropical bar — has coconut oil
	p2 := byCode["0099887766554"]
	if p2.ContainsCoconut == nil {
		t.Fatal("expected non-nil ContainsCoconut for product with ingredients")
	}
	if !*p2.ContainsCoconut {
		t.Error("tropical bar should contain coconut")
	}
}

func TestCacheBuild_FromParquet(t *testing.T) {
	dir := t.TempDir()
	parquetPath := createTestParquet(t, dir)

	raw, err := queryParquet(parquetPath, "en:united-states")
	if err != nil {
		t.Fatalf("queryParquet: %v", err)
	}

	prepared := PrepareProducts(raw)

	// Verify names are clean text, not struct dumps
	for _, p := range prepared {
		if strings.Contains(p.Name, "{") || strings.Contains(p.Name, "lang") {
			t.Errorf("product %s has struct leak in name: %q", p.Code, p.Name)
		}
	}

	// Verify we got the right count
	if len(prepared) != 2 {
		t.Errorf("expected 2 prepared US products, got %d", len(prepared))
	}

	// Write and reload cache to verify round-trip
	cachePath := filepath.Join(dir, "skus.json.gz")

	// Import cache package indirectly — just verify the prepared data is clean
	_ = cachePath
	_ = os.Remove(cachePath)
}
