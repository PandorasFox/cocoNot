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

type StatusChange struct {
	ID                  uuid.UUID `json:"id"`
	ProductID           uuid.UUID `json:"product_id"`
	OldContainsCoconut  *bool     `json:"old_contains_coconut"`
	NewContainsCoconut  *bool     `json:"new_contains_coconut"`
	Reason              string    `json:"reason"`
	ChangedAt           time.Time `json:"changed_at"`
	ProductName         string    `json:"product_name" db:"product_name"`
	ProductBrand        string    `json:"product_brand" db:"product_brand"`
}

// ProductDetail is the full view of a product with all its sources and flags.
type ProductDetail struct {
	Product
	Sources []IngredientSource `json:"sources"`
	Flags   []UserFlag         `json:"flags"`
	History []StatusChange     `json:"history"`
}

// FlagRequest is what the user submits when flagging a product.
type FlagRequest struct {
	FlagType string `json:"flag_type"`
	Notes    string `json:"notes"`
}
