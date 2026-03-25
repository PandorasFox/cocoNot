# CoconutFree - Dev Log

## 2026-03-22 — Project Kickoff

### The Problem
Girlfriend has a severe coconut allergy. Many frozen dairy treats (ice cream, gelato, sorbet) contain coconut milk/oil as a cheaper dairy substitute. Need a tool to track which products are safe.

### Core Requirements Discussed
1. **Product database** — frozen dairy treats available in Seattle, enriched from grocery websites + brand listings
2. **Ingredients tracking by SKU** — normalize products, track ingredient changes over time
3. **Safe / Not Safe UI** — visually clear, easy to parse at a glance
4. **Temporal safety model** — "no coconut as of DATE", always encourage verifying the actual label
5. **Tech stack** — React frontend (mobile-first web app) + lightweight backend serving static skeleton + product DB
6. **Search** — SKU lookup, fuzzy brand/item name matching
7. **Stretch: barcode scanning** — browser camera APIs for scanning barcodes in-store
8. **Stretch: visual product matching** — camera -> draw colored boxes on recognized products (blue = "likely safe, check it")
9. **User flagging** — report inaccuracies, user flags override scraped data (especially true positives for coconut presence)
10. **Change tracking** — index of products that recently changed safe/unsafe status
11. **Data sourcing** — web scraping grocery sites, brand ingredient lists, Open Food Facts, etc.

### Decisions
- Planning phase — designing architecture before writing code.

## 2026-03-23 — Session 2: Architecture Finalized + Scaffolding

### Tech Stack Finalized
- **Backend:** Go (chi router + pgx)
- **Frontend:** React (Vite + TypeScript + TailwindCSS)
- **Database:** PostgreSQL 16 (in-container)
- **Deployment:** Docker Compose, self-hosted

### Critical Mental Model Correction
User correctly pushed back on "SAFE / NOT SAFE" terminology. Two categories:
- **CONTAINS COCONUT** — high confidence dangerous, skip it
- **POSSIBLY CLEAN (as of DATE)** — no coconut found in our data, but ALWAYS check the label

This is a filtering tool for eliminating the dangerous, NOT a source of truth for what's safe.

### Data Source Strategy
- Open Food Facts API + web scrapers as separate `ingredient_sources` rows
- User flags for coconut presence always override scraped data (safety-critical)
- One positive from any source = contains coconut, full stop

### Phase 1: Scaffolding — Complete
All scaffolding built and compiling:

**Backend (Go):**
- `backend/main.go` — server entry, runs migrations, serves API + static frontend
- `backend/internal/models/` — Product, IngredientSource, UserFlag, StatusChange types
- `backend/internal/db/` — pgxpool connection, all queries (list, detail, barcode lookup, fuzzy search, flagging, reclassification log)
- `backend/internal/api/` — chi router, all REST handlers
- `backend/internal/coconut/` — coconut keyword detection (coconut, cocos nucifera, copra)
- `backend/migrations/001_initial` — full schema with pg_trgm indexes

**Frontend (React + Vite + Tailwind):**
- Home/Search page — debounced search, filter toggles (all / possibly clean / contains coconut)
- Product detail page — ingredient sources, status history, flag submission
- Reclassified page — recently changed products (watch list)
- Components: StatusBadge (red/amber/gray), ProductCard, Nav, Disclaimer banner

**Infrastructure:**
- `docker-compose.yml` — Go app + Postgres 16, healthcheck
- `Dockerfile` — multi-stage (build frontend, build Go, alpine runtime)
- API proxied through Vite dev server for local development

### Next Steps (Phase 2)
- Open Food Facts API client to ingest frozen dessert products
- Coconut detection pipeline to populate the database
- Web scraper framework for grocery sites

## 2026-03-23 — Session 3: Open Food Facts API Research

### API Research Complete
Thoroughly tested the Open Food Facts API with live requests. Key findings documented below for building the Go client.

**Two search approaches:**
1. V2 API (`/api/v2/search`) — structured tag-based filtering, preferred for category queries
2. V1 API (`/cgi/search.pl`) — supports full-text search, useful for keyword matching

**Relevant category tags and product counts (US only):**
- `categories_tags=en:ice-creams-and-sorbets` — 1,627 US products
- `categories_tags_en=ice-cream` + `countries_tags_en=united-states` — 1,437 products
- `categories_tags_en=frozen-desserts` + `countries_tags_en=united-states` — 11,240 products
- `categories_tags_en=sorbet` — 2,200 globally
- `categories_tags_en=gelato` — 1 globally (very sparse)

**Rate limits are strict:**
- Search: 10 req/min
- Read: 100 req/min
- Facets: 2 req/min

**Max page_size is 100** (server caps regardless of what you request).

**Fields we need:** code, product_name, brands, ingredients_text, categories_tags_en, allergens_tags, traces_tags, image_url, image_front_url, stores_tags, countries_tags_en, last_modified_t

**Strategy decision:** Use `en:ice-creams-and-sorbets` as the broadest relevant category with US country filter. Paginate through all ~1,600 products at 100/page = 16 requests. At 10 req/min that's under 2 minutes for a full sync.

## 2026-03-23 — Session 4: Open Food Facts Self-Hosting Research

### Goal
Research self-hosting the Open Food Facts database on a NAS to avoid API rate limits.

### Database Dump Formats Available
All exports are generated **nightly** from the live database.

| Format | URL | Compressed | Uncompressed | Notes |
|--------|-----|-----------|--------------|-------|
| MongoDB dump | `https://static.openfoodfacts.org/data/openfoodfacts-mongodbdump.gz` | ~6 GB | ~39 GB | Native format, direct restore |
| JSONL | `https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz` | ~7 GB | ~43 GB | One JSON object per line |
| CSV (tab-separated) | via advanced search or data page | ~0.9 GB | ~9 GB | UTF-8, tab-delimited |
| Parquet | `https://huggingface.co/datasets/openfoodfacts/product-database` | ~1-2 GB | N/A (columnar) | Simplified/filtered, 4.4M rows, 150+ columns |
| RDF | `https://world.openfoodfacts.org/data/en.openfoodfacts.org.products.rdf.gz` | ? | ? | Experimental, not maintained |

Delta exports (incremental changes) available for the last 14 days at `https://static.openfoodfacts.org/data/delta/index.txt`.

### Self-Hosting Options

**Option A: Full openfoodfacts-server (Docker Compose)**
- Repo: `github.com/openfoodfacts/openfoodfacts-server`
- Services: Perl backend, MongoDB, PostgreSQL (via openfoodfacts-query), Memcached, Nginx
- Dev setup: `make dev` builds containers + loads ~100 sample products
- Production-like: `docker-compose.yml;docker/prod.yml;docker/mongodb.yml`
- Resource-heavy: recommends 6+ CPU cores, 8 GB RAM for Docker alone, 8 GB MongoDB cache
- This is the entire OFF website + API — massive overkill for our use case

**Option B: search-a-licious (Lightweight search API)**
- Repo: `github.com/openfoodfacts/search-a-licious`
- Python + TypeScript, Elasticsearch-backed
- Has its own docker-compose.yml
- Designed as a pluggable search service for large collections
- More appropriate for "I just want to search OFF data" use cases
- Still requires Elasticsearch (RAM-hungry)

**Option C: DuckDB + Parquet (Lightest weight)**
- Download `food.parquet` from Hugging Face (~1-2 GB)
- Query directly with DuckDB — no server process needed
- Filter by country (`countries_tags`), category (`categories_tags`), ingredients, allergens
- Can extract a US-only frozen desserts subset in a single SQL query
- Update: re-download parquet nightly (or weekly)
- Example: `SELECT * FROM 'food.parquet' WHERE list_contains(countries_tags, 'en:united-states') AND list_contains(categories_tags, 'en:ice-creams-and-sorbets')`

**Option D: MongoDB dump + custom API**
- Download the 6 GB MongoDB dump nightly
- Restore into a local MongoDB instance
- Write a thin API layer (Go) that queries MongoDB directly
- Most flexible but requires maintaining MongoDB + custom code

### Subset Strategies
- **API filtering at query time:** All formats support filtering by `countries_tags` and `categories_tags` after loading
- **No pre-filtered country/category dumps** exist — you always download the full dump and filter locally
- **Parquet + DuckDB** is ideal for extracting subsets without loading the full dataset into memory (columnar format means you only read columns you need)
- **CSV** can be filtered with standard tools (awk, pandas) but the full file is ~9 GB uncompressed

### Recommendation for CoconutFree
Given our use case (only ~1,600 US frozen dessert products), the full self-hosting approach is overkill. Best options in order:

1. **Parquet + DuckDB** — Download the parquet file weekly, extract our subset into PostgreSQL. Tiny footprint, no running services, trivially scriptable. The parquet file acts as our "upstream sync source."
2. **Direct API with rate limiting** — For ~1,600 products at 100/page, a full sync is only 16 requests (~2 min). Do this daily or weekly. Simplest approach, no local OFF infrastructure needed.
3. **MongoDB dump** — Only if we outgrow the API approach and need access to the full dataset for some reason.

The full openfoodfacts-server Docker setup is not worth it for us — it's designed for running the entire OFF website, not for data consumers.

## 2026-03-24 — Phase 2: Parquet Ingestion Pipeline Built

### Decision
User chose **Parquet + DuckDB** approach. User will self-host the parquet file on their NAS.

### What Was Built
`backend/internal/ingest/off.go` — full ingestion pipeline:

1. **Downloads** the OFF `food.parquet` from Hugging Face (~2 GB) to a persistent Docker volume
2. **Queries with DuckDB** (in-process via `go-duckdb`) — filters to US frozen desserts across 10 category tags:
   - `en:ice-creams-and-sorbets`, `en:frozen-desserts`, `en:ice-creams`, `en:sorbets`, `en:gelati`, `en:frozen-yogurts`, `en:ice-cream-bars`, `en:ice-cream-sandwiches`, `en:ice-cream-tubs`, `en:popsicles`
3. **Runs coconut detection** on each product's `ingredients_text`
4. **Upserts into Postgres** — inserts new products, updates existing, logs status changes to `status_changelog`
5. **Respects user flags** — never overwrites a user's `found_coconut` flag with scraped data

### CLI Usage
```
./coconutfree ingest          # run ingestion
./coconutfree                 # start the web server (default)
```

### Docker Usage
```
docker compose run --rm ingest    # one-off ingestion run
docker compose up                 # start the web app
```

`offdata` Docker volume persists the parquet file between runs (skips re-download if <24h old).

### Category Classification
Products auto-classified based on OFF category tags: ice_cream, sorbet, gelato, frozen_yogurt, novelty (bars/sandwiches/popsicles), other.

### Build Issues Resolved
1. **Alpine + DuckDB incompatibility** — `go-duckdb` ships a static `libduckdb.a` compiled against glibc. Alpine uses musl, causing undefined symbol errors (`__memcpy_chk`, `__memset_chk`). Fixed by switching Dockerfile to Debian bookworm for both build and runtime stages.
2. **Go version mismatch** — local Go was 1.26, Dockerfile had `golang:1.23`. Updated to `golang:1.26-bookworm`.
3. **Parquet schema surprises** — OFF parquet file uses LIST types for columns we expected to be VARCHAR (e.g. `product_name`). Also `image_url` column doesn't exist (it's `image_front_url`). Fixed by dynamically discovering the schema with `DESCRIBE SELECT *` and building CAST expressions accordingly.
4. **Docker Compose `--profile` not supported** — user's Docker Compose version doesn't have profiles. Removed the profiles constraint from the ingest service.

### First Successful Ingestion
- Parquet download: **4,236.8 MB** (~4.2 GB, larger than expected)
- Query result: **11,134 products** matching US frozen dessert categories
- Inserted: **11,123 products** (11 skipped due to missing code/name)
- Time: ~50 seconds for download, seconds for query + upsert

### Scope Expansion Discussion
User wants to keep the **entire** OFF dataset (not just frozen desserts) — had an incident where handsoap contained coconut. Will widen the category filter in a future session to support barcode-scan-anything use case.

### Initial Commit
`42329fc` — full project scaffolding + working ingestion pipeline.

## 2026-03-25 — Session 4: Cleanup + Rename to CocoNot

### User Feedback (all valid)
1. **Confidence field was fake** — every source was just stamped "medium" with no real logic behind it. Removed entirely (migration 002, stripped from models/queries/ingest/frontend).
2. **Disclaimer phrasing** — changed from "This tool helps filter — it is not a guarantee" to "Always check the label! Online sources are not always up to date."
3. **Raw JSON/multilingual ingredient text** — OFF data has ingredients in multiple languages. Ingestion now prefers `ingredients_text_en` for display, but concatenates ALL `ingredients_text_*` columns for coconut detection (catches coconut in any language).
4. **Rename to CocoNot** — all user-facing strings updated (nav, page title, log messages, user-agent). Go module path and DB credentials left as-is (internal plumbing).

## 2026-03-25 — Session 5: Major Cleanup Pass

### User Feedback Round 2
Lots of good catches from testing the actual UI:

1. **Status badge overhaul** — dropped "Possibly clean as of DATE". Now just two states:
   - **CONTAINS COCONUT** (red)
   - **¯\_(ツ)_/¯** (gray) — "fuck if I know, read the label"
2. **User-agent** — changed to `github.com/pandorasfox/coconot`
3. **Product images** — now displayed on cards (16x16) and detail page (24x24)
4. **SKU search** — search bar detects numeric-only input and does direct SKU lookup. Note: SKU != barcode. Barcode scanning is a future feature.
5. **Dropped flagging UI** — removed "I found coconut" / "Report an issue" buttons. App is read-only. Instead, link to product on Open Food Facts with "Contribute to correct ingredient issues!"
6. **OFF links** — ingredient source type is now a clickable link to the OFF product page
7. **Localization fix** — the ROOT CAUSE: parquet stores `product_name` and `ingredients_text` as `LIST(STRUCT(lang, text))`. Old code used `array_to_string()` which dumped raw struct repr as `{'lang': main, 'text': Premium Ice Cream}`. Fixed with DuckDB `UNNEST` to extract `en`/`main` lang text properly.
8. **Coconut detection** — now scans ALL language variants of ingredients (not just EN) by concatenating all `ingredients_text_*` columns
9. **Duplicate ingredient sources** — added unique index on `(product_id, source_type)` with proper `ON CONFLICT DO UPDATE` upsert (migration 003)

### Frontend text parser (workaround for existing data)
DuckDB UNNEST fix didn't propagate on re-ingestion (0 updated, 11123 unchanged — upsert sees no coconut status change so "unchanged" counter fires even though brand/name DO get updated). Added `extractText()` frontend parser in `frontend/src/api/parse.ts` that extracts plain text from `{'lang': main, 'text': ...}` struct blobs at display time. Applied to product names, brands, and ingredients in ProductCard and ProductDetail.

### Open issues for next session
- **Images not rendering** — image column may not exist in the OFF parquet file with expected names. Added debug logging for image column discovery. Need to check what actual column names are available.
- **Ingestion UNNEST** — DuckDB struct extraction may be silently falling through. Need to verify with sample row logging.

## 2026-03-25 — Session 6: Barcode Scanner Feature

### What Was Built
Barcode scanning from the phone camera, entirely client-side:

1. **`barcode-detector` npm package** — polyfill for the BarcodeDetector Web API, uses ZXing C++ WASM under the hood. Works on all browsers (native BarcodeDetector on Chrome, WASM fallback elsewhere including Safari/iOS).

2. **`frontend/src/api/barcode.ts`** — utility module. Creates a `BarcodeDetector` instance targeting product barcode formats (EAN-13, UPC-A, EAN-8, UPC-E). Takes a `File` from the camera, converts to `ImageBitmap`, runs detection.

3. **`frontend/src/components/BarcodeScanner.tsx`** — UI component:
   - **Blue sticky footer button** on all pages with a barcode icon
   - Hidden `<input type="file" accept="image/*" capture="environment">` — triggers the phone's rear camera for a single photo (no video stream)
   - Processing overlay ("Reading barcode...") while WASM decodes
   - On success: tries `getProductByBarcode(sku)` → navigates to product detail if found, otherwise navigates to `/?q=SKU` for text search fallback
   - Error toast for "no barcode found" or decode failures

4. **`App.tsx`** — added `<BarcodeScanner />` outside Routes so it's available on every page. Added `pb-20` wrapper so page content doesn't hide behind the sticky footer.

5. **`Home.tsx`** — reads `?q=` URL search param to initialize the search input, so barcode scanner's fallback navigation (`/?q=SKU`) auto-triggers a search.

### Architecture Notes
- Single-frame capture approach (not webcam/video stream) — browser handles camera permissions via the file input
- Barcode detection runs entirely in the browser (ZXing WASM) — no server round-trip for the image processing
- The flow: camera → image file → ImageBitmap → BarcodeDetector.detect() → SKU string → API lookup → navigation

## 2026-03-25 — Session 7: Cron Scheduler + Upsert Fixes + Reclassified UX

### Periodic Ingestion Scheduler
- New `backend/internal/ingest/scheduler.go` — `Scheduler` struct with `Start(ctx)` that runs ingestion immediately on startup, then repeats on a configurable interval (default 6h)
- Uses `atomic.Bool` to prevent concurrent runs; logs errors without crashing the server
- Wired into `main.go` — starts if `DATA_DIR` env var is set (presence of the offdata volume)
- `docker-compose.yml` updated: `app` service now mounts `offdata:/data` and sets `DATA_DIR`/`INGEST_INTERVAL`
- `ingest` service kept for manual one-off runs
- Download function now uses `http.NewRequestWithContext` for proper graceful shutdown

### Upsert Stats Fix
- Added `refreshed` counter to `upsertStats` — products where data was re-written but coconut status stayed the same
- `unchanged` now reserved for user-flagged products that are completely skipped
- Log message now clearly reports: inserted / updated (status change) / refreshed / skipped (user-flagged)

### Reclassified Page: Product Info
- `StatusChange` model now includes `ProductName` and `ProductBrand`
- `GetReclassified` query JOINs products table to populate them
- Frontend shows brand + name on each changelog entry (no more anonymous "something changed" cards)

### Image Rendering Safety Net
- Applied `extractText()` to `product.image_url` in `ProductCard.tsx` and `ProductDetail.tsx`
- If image URLs come through as struct blobs from the parquet, the frontend now extracts the clean URL
- Added temporary sample-row logging in `off.go` to diagnose actual image URL shape from DuckDB

### Next: verify
- Run `docker compose up --build` and check ingestion logs for:
  - Scheduler startup message
  - Sample image URLs (clean vs struct blob)
  - Stats breakdown
- Check Reclassified page shows product names
- Verify images render on product cards

## 2026-03-25 — Session 7 (cont): Barcode Scanner → Live Viewfinder

### Upgrade: File Picker → Camera Viewfinder
Replaced the `<input type="file" capture>` approach with a live camera viewfinder using `getUserMedia`.

**`barcode.ts` additions:**
- `detectBarcodeFromVideo(video)` — grabs a single frame from a `<video>` element, runs BarcodeDetector
- `detectBarcodeBurst(video, frames=5, intervalMs=60)` — captures 5 frames over ~300ms, decodes all in parallel, returns the most common result (majority vote). Handles motion blur, poor focus, exposure variation.

**`BarcodeScanner.tsx` rewrite:**
- Sticky blue footer button (unchanged) now opens a fullscreen viewfinder overlay
- `getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } })` for rear camera at high resolution
- `<video autoPlay playsInline muted>` — works on iOS Safari
- Tap anywhere on the viewfinder → multi-frame burst scan → navigate on success
- Error toasts stay in viewfinder so user can retry without re-opening the camera
- Close button (X) in top-right corner to dismiss
- Falls back to file picker if getUserMedia fails or is denied
- Properly cleans up camera stream on close, navigation, and unmount

### State machine
```
idle → viewfinder (getUserMedia success) → processing (tap) → idle (navigate)
                                         → error (stay in viewfinder, retry)
idle → file-fallback (getUserMedia failure)
```

### Future: AR passive scanning
This viewfinder architecture is designed to support future passive scanning — continuously detect barcodes every N frames and draw colored overlays on the video. Will need:
- localStorage cache of SKU → contains_coconut for zero-latency lookups
- Canvas overlay on top of video for drawing bounding boxes
- requestAnimationFrame loop for continuous detection

## 2026-03-25 — Session 8: GitHub Actions for Docker Publishing

### What Was Built
Added `.github/workflows/docker-publish.yml` — GitHub Actions workflow to automatically build and push the Docker image to GitHub Container Registry on every push to `main`.

### Workflow Details
- **Trigger:** push to `main`
- **Registry:** `ghcr.io/<owner>/coconutfree`
- **Tags:** `latest` + `sha-<short-hash>` (e.g. `sha-d153b89`)
- **Caching:** GitHub Actions cache (`type=gha`) for Docker layers — speeds up subsequent builds
- **Auth:** uses `GITHUB_TOKEN` (no secrets to configure)
- **Actions used:** checkout@v4, setup-buildx-action@v3, login-action@v3, metadata-action@v5, build-push-action@v6
