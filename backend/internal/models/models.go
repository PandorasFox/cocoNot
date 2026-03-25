package models

import (
	"time"

	"github.com/google/uuid"
)

type Product struct {
	ID              uuid.UUID  `json:"id"`
	SKU             string     `json:"sku"`
	Brand           string     `json:"brand"`
	Name            string     `json:"name"`
	Category        string     `json:"category"`
	ImageURL        *string    `json:"image_url,omitempty"`
	ContainsCoconut *bool      `json:"contains_coconut"`
	StatusAsOf      *time.Time `json:"status_as_of,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type IngredientSource struct {
	ID             uuid.UUID `json:"id"`
	ProductID      uuid.UUID `json:"product_id"`
	SourceType     string    `json:"source_type"` // openfoodfacts, scraper, user_flag, manual
	SourceURL      *string   `json:"source_url,omitempty"`
	IngredientsRaw string    `json:"ingredients_raw"`
	CoconutFound   bool      `json:"coconut_found"`
	FetchedAt      time.Time `json:"fetched_at"`
	CreatedAt      time.Time `json:"created_at"`
}

type UserFlag struct {
	ID        uuid.UUID `json:"id"`
	ProductID uuid.UUID `json:"product_id"`
	FlagType  string    `json:"flag_type"` // found_coconut, wrong_ingredients, other
	Notes     string    `json:"notes,omitempty"`
	PhotoURL  *string   `json:"photo_url,omitempty"`
	Resolved  bool      `json:"resolved"`
	CreatedAt time.Time `json:"created_at"`
}

// ProductDetail is the full view of a product with all its sources and flags.
type ProductDetail struct {
	Product
	Sources []IngredientSource `json:"sources"`
	Flags   []UserFlag         `json:"flags"`
}

// FlagRequest is what the user submits when flagging a product.
type FlagRequest struct {
	FlagType string `json:"flag_type"`
	Notes    string `json:"notes"`
}

// SKUDumpEntry is a compact product entry for the full SKU dump endpoint.
type SKUDumpEntry struct {
	SKU             string `json:"sku"`
	Name            string `json:"name"`
	ContainsCoconut *bool  `json:"contains_coconut"`
}

// SKULookupRequest is the payload for bulk SKU lookups.
type SKULookupRequest struct {
	SKUs []string `json:"skus"`
}

// SKULookupResult is the per-SKU response from a bulk lookup.
type SKULookupResult struct {
	Name            string `json:"name"`
	ContainsCoconut *bool  `json:"contains_coconut"`
}
