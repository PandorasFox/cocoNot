package db

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/hecate/coconutfree/internal/models"
)

type Queries struct {
	pool *pgxpool.Pool
}

func NewQueries(pool *pgxpool.Pool) *Queries {
	return &Queries{pool: pool}
}

func (q *Queries) ListProducts(ctx context.Context, search string, coconutFilter *bool, limit, offset int) ([]models.Product, int, error) {
	where := "WHERE 1=1"
	args := []any{}
	argIdx := 1

	if search != "" {
		where += fmt.Sprintf(" AND (brand ILIKE $%d OR name ILIKE $%d)", argIdx, argIdx)
		args = append(args, "%"+search+"%")
		argIdx++
	}

	if coconutFilter != nil {
		where += fmt.Sprintf(" AND contains_coconut = $%d", argIdx)
		args = append(args, *coconutFilter)
		argIdx++
	}

	// Count total
	var total int
	countQuery := "SELECT COUNT(*) FROM products " + where
	err := q.pool.QueryRow(ctx, countQuery, args...).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("counting products: %w", err)
	}

	// Fetch page
	query := fmt.Sprintf(`
		SELECT id, sku, brand, name, category, image_url, contains_coconut, status_as_of, created_at, updated_at
		FROM products %s
		ORDER BY brand, name
		LIMIT $%d OFFSET $%d
	`, where, argIdx, argIdx+1)
	args = append(args, limit, offset)

	rows, err := q.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("listing products: %w", err)
	}
	defer rows.Close()

	products, err := pgx.CollectRows(rows, pgx.RowToStructByName[models.Product])
	if err != nil {
		return nil, 0, fmt.Errorf("scanning products: %w", err)
	}

	return products, total, nil
}

func (q *Queries) GetProduct(ctx context.Context, id uuid.UUID) (*models.ProductDetail, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT id, sku, brand, name, category, image_url, contains_coconut, status_as_of, created_at, updated_at
		FROM products WHERE id = $1
	`, id)

	var p models.Product
	err := row.Scan(&p.ID, &p.SKU, &p.Brand, &p.Name, &p.Category, &p.ImageURL, &p.ContainsCoconut, &p.StatusAsOf, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("getting product: %w", err)
	}

	detail := &models.ProductDetail{Product: p}

	// Sources
	srcRows, err := q.pool.Query(ctx, `
		SELECT id, product_id, source_type, source_url, ingredients_raw, coconut_found, fetched_at, created_at
		FROM ingredient_sources WHERE product_id = $1 ORDER BY fetched_at DESC
	`, id)
	if err != nil {
		return nil, fmt.Errorf("getting sources: %w", err)
	}
	defer srcRows.Close()
	detail.Sources, err = pgx.CollectRows(srcRows, pgx.RowToStructByName[models.IngredientSource])
	if err != nil {
		return nil, fmt.Errorf("scanning sources: %w", err)
	}

	// Flags
	flagRows, err := q.pool.Query(ctx, `
		SELECT id, product_id, flag_type, notes, photo_url, resolved, created_at
		FROM user_flags WHERE product_id = $1 ORDER BY created_at DESC
	`, id)
	if err != nil {
		return nil, fmt.Errorf("getting flags: %w", err)
	}
	defer flagRows.Close()
	detail.Flags, err = pgx.CollectRows(flagRows, pgx.RowToStructByName[models.UserFlag])
	if err != nil {
		return nil, fmt.Errorf("scanning flags: %w", err)
	}

	// History
	histRows, err := q.pool.Query(ctx, `
		SELECT sc.id, sc.product_id, sc.old_contains_coconut, sc.new_contains_coconut, sc.reason, sc.changed_at,
			p.name AS product_name, p.brand AS product_brand
		FROM status_changelog sc
		JOIN products p ON p.id = sc.product_id
		WHERE sc.product_id = $1 ORDER BY sc.changed_at DESC
	`, id)
	if err != nil {
		return nil, fmt.Errorf("getting history: %w", err)
	}
	defer histRows.Close()
	detail.History, err = pgx.CollectRows(histRows, pgx.RowToStructByName[models.StatusChange])
	if err != nil {
		return nil, fmt.Errorf("scanning history: %w", err)
	}

	return detail, nil
}

func (q *Queries) GetProductByBarcode(ctx context.Context, sku string) (*models.Product, error) {
	row := q.pool.QueryRow(ctx, `
		SELECT id, sku, brand, name, category, image_url, contains_coconut, status_as_of, created_at, updated_at
		FROM products WHERE sku = $1
	`, sku)

	var p models.Product
	err := row.Scan(&p.ID, &p.SKU, &p.Brand, &p.Name, &p.Category, &p.ImageURL, &p.ContainsCoconut, &p.StatusAsOf, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return nil, fmt.Errorf("getting product by barcode: %w", err)
	}

	return &p, nil
}

func (q *Queries) GetReclassified(ctx context.Context, since time.Time, limit int) ([]models.StatusChange, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT sc.id, sc.product_id, sc.old_contains_coconut, sc.new_contains_coconut, sc.reason, sc.changed_at,
			p.name AS product_name, p.brand AS product_brand
		FROM status_changelog sc
		JOIN products p ON p.id = sc.product_id
		WHERE sc.changed_at >= $1
		ORDER BY sc.changed_at DESC
		LIMIT $2
	`, since, limit)
	if err != nil {
		return nil, fmt.Errorf("getting reclassified: %w", err)
	}
	defer rows.Close()

	return pgx.CollectRows(rows, pgx.RowToStructByName[models.StatusChange])
}

func (q *Queries) CreateFlag(ctx context.Context, productID uuid.UUID, flagType, notes string) (*models.UserFlag, error) {
	flag := models.UserFlag{
		ID:        uuid.New(),
		ProductID: productID,
		FlagType:  flagType,
		Notes:     notes,
		Resolved:  false,
		CreatedAt: time.Now(),
	}

	_, err := q.pool.Exec(ctx, `
		INSERT INTO user_flags (id, product_id, flag_type, notes, resolved, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, flag.ID, flag.ProductID, flag.FlagType, flag.Notes, flag.Resolved, flag.CreatedAt)
	if err != nil {
		return nil, fmt.Errorf("creating flag: %w", err)
	}

	// If user flagged coconut presence, immediately update the product
	if flagType == "found_coconut" {
		err = q.markContainsCoconut(ctx, productID, "user flag: found_coconut")
		if err != nil {
			return nil, fmt.Errorf("updating product after flag: %w", err)
		}
	}

	return &flag, nil
}

func (q *Queries) markContainsCoconut(ctx context.Context, productID uuid.UUID, reason string) error {
	// Get current status for changelog
	var oldStatus *bool
	err := q.pool.QueryRow(ctx, "SELECT contains_coconut FROM products WHERE id = $1", productID).Scan(&oldStatus)
	if err != nil {
		return err
	}

	newStatus := true
	now := time.Now()

	// Update product
	_, err = q.pool.Exec(ctx, `
		UPDATE products SET contains_coconut = $1, status_as_of = $2, updated_at = $2 WHERE id = $3
	`, newStatus, now, productID)
	if err != nil {
		return err
	}

	// Log the change
	_, err = q.pool.Exec(ctx, `
		INSERT INTO status_changelog (id, product_id, old_contains_coconut, new_contains_coconut, reason, changed_at)
		VALUES ($1, $2, $3, $4, $5, $6)
	`, uuid.New(), productID, oldStatus, newStatus, reason, now)

	return err
}

func (q *Queries) FuzzySearch(ctx context.Context, query string, limit int) ([]models.Product, error) {
	rows, err := q.pool.Query(ctx, `
		SELECT id, sku, brand, name, category, image_url, contains_coconut, status_as_of, created_at, updated_at
		FROM products
		WHERE brand % $1 OR name % $1 OR brand ILIKE '%' || $1 || '%' OR name ILIKE '%' || $1 || '%'
		ORDER BY GREATEST(similarity(brand, $1), similarity(name, $1)) DESC
		LIMIT $2
	`, query, limit)
	if err != nil {
		return nil, fmt.Errorf("fuzzy search: %w", err)
	}
	defer rows.Close()

	return pgx.CollectRows(rows, pgx.RowToStructByName[models.Product])
}
