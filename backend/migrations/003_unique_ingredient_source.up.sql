-- Deduplicate: keep only the most recent source per product+source_type
DELETE FROM ingredient_sources a
USING ingredient_sources b
WHERE a.product_id = b.product_id
  AND a.source_type = b.source_type
  AND a.created_at < b.created_at;

-- Add unique constraint so we upsert properly
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredient_sources_product_source
  ON ingredient_sources (product_id, source_type);
