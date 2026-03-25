-- Enable pg_trgm for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Core product table, one row per SKU
CREATE TABLE products (
    id UUID PRIMARY KEY,
    sku TEXT UNIQUE NOT NULL,
    brand TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    image_url TEXT,
    contains_coconut BOOLEAN, -- NULL = no data
    status_as_of TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Each data source gets its own row per product
CREATE TABLE ingredient_sources (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL, -- openfoodfacts, scraper, user_flag, manual
    source_url TEXT,
    ingredients_raw TEXT NOT NULL DEFAULT '',
    coconut_found BOOLEAN NOT NULL DEFAULT FALSE,
    confidence TEXT NOT NULL DEFAULT 'medium',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User-submitted corrections
CREATE TABLE user_flags (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    flag_type TEXT NOT NULL, -- found_coconut, wrong_ingredients, other
    notes TEXT NOT NULL DEFAULT '',
    photo_url TEXT,
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tracks status changes over time
CREATE TABLE status_changelog (
    id UUID PRIMARY KEY,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    old_contains_coconut BOOLEAN,
    new_contains_coconut BOOLEAN,
    reason TEXT NOT NULL DEFAULT '',
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_products_brand ON products USING gin (brand gin_trgm_ops);
CREATE INDEX idx_products_name ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_sku ON products (sku);
CREATE INDEX idx_products_contains_coconut ON products (contains_coconut);
CREATE INDEX idx_ingredient_sources_product ON ingredient_sources (product_id);
CREATE INDEX idx_user_flags_product ON user_flags (product_id);
CREATE INDEX idx_status_changelog_product ON status_changelog (product_id);
CREATE INDEX idx_status_changelog_changed_at ON status_changelog (changed_at DESC);
