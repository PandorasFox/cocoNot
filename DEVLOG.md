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

## 2026-03-25 — Session 9: Single-Container Deploy

### What Changed
Embedded PostgreSQL 15 into the app container so deployment is a single `docker run` instead of requiring docker-compose with a separate db service.

### Files
- **`docker-entrypoint.sh`** (new) — startup script that:
  - `chown -R` the PGDATA directory (handles volume ownership)
  - Runs `initdb` on first boot, writes a clean `pg_hba.conf` (peer for local socket, scram-sha-256 for TCP)
  - Starts PostgreSQL via `pg_ctl`, waits for readiness
  - Creates the `coconutfree` role + database if missing
  - `exec "$@"` to hand off to the app binary
- **`Dockerfile`** — runtime stage now installs `postgresql-15`, copies entrypoint, adds PG bin to PATH, sets `DATABASE_URL` default, uses `ENTRYPOINT` + `CMD` pattern
- **`docker-compose.yml`** — removed `db` service entirely, `app` and `ingest` mount `pgdata:/var/lib/postgresql/data` for persistence, `DATABASE_URL` uses localhost (set as image default)

### Notes
- Debian bookworm ships PG 15 (not 16). No PG16-specific features used, so this is fine.
- Image is larger (~318 MB of PG + deps) but eliminates multi-container orchestration.
- `docker run -p 8080:8080 -v pgdata:/var/lib/postgresql/data -v offdata:/data coconutfree-app` is now a valid single-command deploy.

## 2026-03-25 — Session 10: Highlight Coconut in Ingredients

### What Changed
- Product detail page now **bolds and colors red** any coconut-related keywords (`coconut`, `cocos nucifera`, `copra`) in the raw ingredients text
- Uses regex split/match to wrap matching substrings in `<span className="font-bold text-red-600">` while preserving the original casing
- Makes it immediately obvious when coconut is present in a wall of ingredient text

## 2026-03-25 — Session 11: Rotated Barcode Detection

### Problem
Rotated barcodes (90°, 180°, 270°) failed to scan. The ZXing WASM engine inside `barcode-detector` doesn't reliably handle rotated 1D barcodes (EAN/UPC).

### Fix
Added rotation retry logic to `frontend/src/api/barcode.ts`:
- New `rotateBitmap(src, degrees)` — uses `OffscreenCanvas` to rotate an `ImageBitmap` by arbitrary degrees (computes bounding box from cos/sin)
- New `detectWithRotations(bitmap)` — tries detection at 0°, then 45°, then 90° if no barcode found. 1D barcodes are symmetric so 180°/270° are redundant
- Applied to all three detection paths: `detectBarcode` (file picker), `detectBarcodeFromVideo` (single frame), and `detectBarcodeBurst` (multi-frame burst)

## 2026-03-25 — Session 12: IndexedDB Cache + SKU Lookup API + Viewfinder Hitboxes

### What Was Built
Three interconnected features for real-time barcode status overlay in the viewfinder:

**1. Bulk SKU Lookup Endpoint — `POST /api/products/sku-lookup`**
- Accepts `{ "skus": ["...", "..."] }`, returns `{ "results": { "sku": { "name", "contains_coconut" } } }`
- Minimal response surface — only returns name + coconut status (no full product objects)
- SKUs not in DB are simply absent from results (client infers "not found")
- Capped at 50 SKUs per request
- Backend: `LookupSKUs()` query uses `WHERE sku = ANY($1)` for single-query batch lookup

**2. IndexedDB Cache — `frontend/src/api/cache.ts`**
- Chose **IndexedDB over localStorage**: 50 MB+ storage (vs 5-10 MB), async keyed lookups (vs parsing entire JSON blob every read), scales to millions of records
- DB: `coconot`, object store: `skus`, keyPath: `sku`
- Three statuses: `coconut` (red), `clean` (yellow), `not_found` (blue)
- Populated on-demand from: search results, product detail views, barcode scans, and batch SKU lookups
- `cachedAt` timestamp stored for future staleness/TTL support
- Future: settings page with "Download database" button for category-based preloading with size estimates

**3. Viewfinder Hitbox Overlays — `BarcodeScanner.tsx`**
- `<canvas>` element overlaid on `<video>` with `pointer-events: none`
- Continuous detection loop (300ms `setInterval`) runs `detectBarcodesWithBounds()` while viewfinder is open
- Coordinate mapping from video natural dimensions → display dimensions handles `object-cover` scaling/cropping
- Colored rounded-rect borders drawn around detected barcodes:
  - **Red** = contains coconut
  - **Yellow** = in DB, no coconut detected
  - **Blue** = SKU not in database
  - No border = not yet looked up (fires batch API call, resolves on next frame)
- In-flight SKU deduplication via `Set<string>` ref prevents duplicate API calls
- Tap still navigates to product detail (existing behavior preserved)

### Cache Population Points
- `Home.tsx`: `putProducts()` after search results load
- `ProductDetail.tsx`: `putProduct()` after product detail loads
- `BarcodeScanner.tsx`: `putProduct()`/`putNotFound()` after barcode lookup, batch `putSKULookupResults()` from viewfinder detection loop

## 2026-03-25 — Session 13: Hitbox Polish, Cache TTL, Preload Button, Remove Watchlist

### Hitbox Stabilization + Labels (`BarcodeScanner.tsx`)
- **Persistent hitbox map** in a ref (`Map<string, HitboxEntry>`) — detections merge into the map instead of redrawing from scratch each tick
- **2-second retention** — barcodes that disappear for <2s keep their hitbox (prevents flicker from momentary detection misses)
- **Detection interval 300ms → 1000ms** — reduces battery drain and jitter
- **16px padding** on all sides of bounding boxes — easier to see
- **Text label chips** drawn above each hitbox:
  - Background color matches hitbox border (red/yellow/blue)
  - Shows product name (truncated to 25 chars) or status fallback ("COCONUT"/"CLEAN"/"UNKNOWN")
  - Text color via WCAG relative luminance: white on dark backgrounds, black on light (yellow)
  - Small rounded chip with 4px horizontal / 2px vertical padding

### Cache TTL — 1 Week (`cache.ts`)
- `CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000`
- `getStatus()` and `getStatuses()` treat entries where `cachedAt + TTL < Date.now()` as cache misses
- Expired entries left in IndexedDB (lazy overwrite on next lookup)

### SKU Dump Endpoint — `GET /api/products/sku-dump`
- Returns all products in compact format: `{ products: [{ sku, name, contains_coconut }], total }`
- Backend: `DumpSKUs()` query, `SKUDump` handler, new route
- Frontend: `skuDump()` client function, `putDump()` bulk cache write

### "Cache SKUs" Button (`Nav.tsx`)
- Replaced "Watch List" nav link with "Cache SKUs" button
- On click: fetches full SKU dump → writes to IndexedDB → shows "Cached N products" confirmation
- Spinner while loading, auto-resets after 3 seconds

### Watchlist Removal
- Deleted `Reclassified.tsx` page
- Removed `/reclassified` route from `App.tsx`
- Removed `GetReclassified` handler, route, and query from backend
- Removed `StatusChange` struct from `models.go`
- Removed `History` field from `ProductDetail` struct and the history query in `GetProduct()`
- Removed `StatusChange` interface, `getReclassified()`, and `history` field from frontend client
- Removed "Status History" section from `ProductDetail.tsx`
- Kept: `status_changelog` table + write path (audit trail)

## 2026-03-25 — Session 14: Ingredient OCR Viewfinder

### What Was Built
Added a second viewfinder mode for OCR-based ingredient scanning using Tesseract.js. When barcode data isn't available, users can point their phone at the ingredient list and see real-time red hitboxes around coconut-related keywords.

**1. `tesseract.js` dependency**
- Tesseract.js v5 bundles its own WASM core + creates a Web Worker internally
- ~4MB English trained data fetched from CDN on first load, then browser-cached

**2. `frontend/src/api/ocr.ts` — OCR engine module**
- Singleton Tesseract worker with pub/sub readiness state (`'loading' | 'ready' | 'error'`)
- `initOcr()` — eagerly initialize worker (idempotent, called from splash screen)
- `recognizeCoconutHits(video)` → `OcrHit[] | null` — full pipeline:
  - Capture frame to OffscreenCanvas at native resolution
  - Grayscale conversion in-place
  - Otsu's method for adaptive binary threshold (handles varying lighting)
  - Tesseract OCR on the preprocessed frame
  - Keyword matching: `coconut`, `copra` (single word), `cocos nucifera` (two-word with merged bounding boxes)
  - Returns hits in video-pixel coordinates
- Crash recovery: if `worker.recognize()` throws, `terminateOcr()` resets the singleton. Next `initOcr()` recreates the worker.

**3. `frontend/src/components/SplashScreen.tsx`**
- Full-screen overlay at `z-[100]` showing 🚫🥥🚫 + "CocoNot" + loading status
- Calls `initOcr()` on mount, subscribes to readiness changes
- Dismisses on ready/error or after 15s safety timeout
- Self-removes from DOM once dismissed

**4. `frontend/src/components/BarcodeScanner.tsx` — dual-mode refactor**
- New state machine with `ViewfinderMode = 'barcode' | 'ocr'` discriminant
- **Removed all file picker code**: `inputRef`, `openFilePicker`, `handleFile`, hidden `<input>`, blue "Scan Barcode" button, file-picker error toast and processing overlay
- Two detection loops branching on mode:
  - **Barcode mode:** existing `setInterval(1000)` logic unchanged
  - **OCR mode:** adaptive `while` loop with `setTimeout(200)` cooldown — no pile-up of work
- Both modes write to the same `hitboxMapRef` and use the same `drawHitboxes()` function (extracted from inline code)
- New button layout: `[Pink: bARcode Glance] [Blue: Ingredient OCR]`
- OCR button subscribes to `onOcrReadyChange` for loading/ready/error states
- Mode-aware hint text ("Tap to scan barcode" vs "Point at ingredient list")
- Tap-to-scan only active in barcode mode

**5. `frontend/src/api/barcode.ts` cleanup**
- Removed unused `detectBarcode(file: File)` export

**6. Fix: hitbox labels showing raw JSON blobs**
- `cache.ts` now runs `extractText()` on product names at write time so IndexedDB stores clean text for label chips

## 2026-03-25 — Session 16: OCR Debug Visual Feedback

### Problem
Ingredient OCR mode appeared to do nothing — just showed "Point at ingredient list" with no visual feedback that OCR was running or detecting any text.

### Fix
- **`ocr.ts`**: Renamed `recognizeCoconutHits` → `recognizeWords`. Now returns ALL detected words tagged with `isCoconut: boolean` instead of only coconut matches.
- **`BarcodeScanner.tsx`**: Added `drawOcrHitboxes()` — draws subtle green boxes around all detected words, bold red boxes around coconut matches. Each word gets a small label chip.
- **Debug status pill**: Top-left overlay in OCR mode shows live stats: `OCR: ready`, `frames: N`, `words: N`, and highlights `COCONUT: N` in red when matches found.
- This gives immediate visual confirmation that OCR is running, what text it's finding, and whether any coconut keywords were detected.

## 2026-03-25 — Session 17: PWA + Service Worker + Server Health Check

### Problem
Two issues: (1) Tesseract.js downloads ~5-6MB of WASM/worker/traineddata from jsdelivr CDN on every visit. (2) Backend starts serving HTTP immediately while ingestion runs async in background — users see empty results for 2-5 minutes on cold start.

### PWA + Service Worker
- Added `vite-plugin-pwa` (Workbox-based `generateSW` mode)
- **App shell precaching**: all build output (JS, CSS, HTML, images) cached automatically
- **Tesseract CDN runtime caching**: `CacheFirst` strategy for `cdn.jsdelivr.net/*` — worker script, WASM core, and eng.traineddata are downloaded once then served from `tesseract-cdn-cache` on all subsequent visits. Versioned URLs with 1-year expiry.
- API calls (`/api/*`) excluded from SW via `navigateFallbackDenylist`
- `registerType: 'autoUpdate'` — SW silently updates on new deployments
- Web app manifest: name, icons, theme/background colors, `display: standalone`, portrait orientation
- Apple PWA meta tags in index.html: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, `apple-mobile-web-app-title`, `apple-touch-icon`

### App Icons
- Created `public/icons/icon.svg`: dark rounded rect (#0f172a) + red prohibition circle + "CN" text
- Generated `icon-192.png` and `icon-512.png` via sharp-cli
- 512px icon also serves as maskable icon

### Server Health Endpoint
- `backend/internal/ingest/scheduler.go`: added `ready atomic.Bool` field + `Ready()` method. Set to `true` after first `runOnce()` completes.
- `GET /api/health` returns `{ "ready": true/false }`. Always 200 (liveness). `ready` field tracks first ingestion completion. Defaults to `true` when no scheduler (DATA_DIR unset).
- Wired in `main.go` — hoisted `sched` variable to pass `sched.Ready` as `readyFunc` to router.

### Splash Screen Enhancement
- `SplashScreen.tsx` now waits for **both** server readiness and OCR readiness
- Polls `GET /api/health` every 2 seconds until `ready: true`
- Status text: "Server starting up..." → "Loading OCR engine..." → dismissed
- 15-second safety timeout preserved

### Build Output
```
dist/registerSW.js          0.13 kB
dist/manifest.webmanifest   0.50 kB
dist/sw.js                  (generated by Workbox)
dist/workbox-*.js           (Workbox runtime)
```

## 2026-03-25 — Session 18: OCR Zero-Words Bug Hunt

### Root Cause
OCR debug pill showed `words: 0` on every frame. Tesseract.js v7 breaking change: `worker.recognize()` no longer populates `result.data.blocks` by default — it returns `null`. Must pass `{ blocks: true }` as the third argument:
```
// Before (v5/v6 behavior, blocks populated automatically):
result = await worker.recognize(source)

// After (v7 requires explicit opt-in):
result = await worker.recognize(source, {}, { blocks: true })
```

`result.data.text` still returned recognized text, but the hierarchical `blocks → paragraphs → lines → words` structure was `null`, so `flattenWords()` always returned an empty array.

### Fix
One-line change in `ocr.ts` for both `recognizeWords()` and `recognizeImageSource()`.

### Test Infrastructure
Set up Vitest + test suite for OCR:
- Installed `vitest` + `canvas` (node-canvas for synthetic test images) as devDependencies
- `frontend/vitest.config.ts` — 30s timeout for Tesseract operations
- `npm test` / `npm run test:watch` scripts
- Refactored `ocr.ts` to export testable pieces:
  - `otsuThreshold()` — now exported for unit testing
  - `tagCoconutWords(words)` — pure function extracted from `recognizeWords`, takes any `WordBox[]`
  - `flattenWords(blocks)` — extracted block traversal
  - `recognizeImageSource(source)` — accepts file path/Buffer for Node.js testing (bypasses video/canvas preprocessing)
- Test suite at `src/api/__tests__/ocr.test.ts`:
  - Unit: `otsuThreshold` with synthetic bimodal data
  - Unit: `tagCoconutWords` — coconut/copra/cocos nucifera matching, punctuation stripping, bbox merging
  - Integration: Tesseract on synthetic black-on-white PNG (verifies engine works)
  - Integration: auto-discovers real photos in `frontend/test-data/ocr-images/` — logs word count, confidence, coconut matches
- **34/34 tests passing**, including real photo detection (97-522 words per image, COCONUT correctly flagged in test image)

## 2026-03-25 — Session 15: Favicon

### What Was Built
- Combined Google Noto Emoji SVGs (coconut 🥥 + prohibition sign 🚫) into a single `favicon.svg`
- Coconut layer renders underneath, prohibition sign overlays on top (transparent center shows coconut through)
- Placed in `frontend/public/favicon.svg` (Vite copies to root on build)
- Added `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />` to `index.html`

## 2026-03-25 — Session 19: Progress Tracking + Full OFF Database + Configurable Allergens

### Three Related Changes

**1. Ingestion Progress Tracking**
- Added `Progress` struct to `scheduler.go` with `Phase`/`Current`/`Total` fields, stored in `atomic.Value`
- `RunOFF` now accepts a `ProgressFunc` callback, called during download (counting reader every ~512KB), query, and upsert (every 100 products)
- Health endpoint (`GET /api/health`) returns progress alongside `ready` status
- Splash screen shows a progress bar with phase-aware text: "Downloading... 45%", "Processing products...", "Loading products... 5,000 / 150,000"
- Removed 15s safety timeout, replaced with 5-minute timeout (progress bar makes the wait transparent)

**2. Full OFF Database**
- Removed the 10-line frozen dessert category filter from the DuckDB query
- Now ingests ALL products matching the country filter (not just ice cream/sorbet/gelato)
- Supports the barcode-scan-anything use case (handsoap incident from Session 4)

**3. Configurable Allergens + Country**
- `ALLERGEN_KEYWORDS` env var (default `coconut,cocos nucifera,copra`) — parsed once via `sync.Once`, split/lowered/trimmed
- `INGEST_COUNTRIES` env var (default `en:united-states`) — set to `-` for all countries
- Dockerfile bakes sensible defaults for all env vars (PORT, FRONTEND_DIR, MIGRATIONS_DIR, DATA_DIR, INGEST_INTERVAL, INGEST_COUNTRIES, ALLERGEN_KEYWORDS)
- Project can now be forked for any allergen with zero code changes

### New Documentation
- `docs/DEPLOYMENT.md` — quick start, docker compose example, env var reference table, volume mounts
- `docs/OTHER_ALLERGIES.md` — forking guide with examples for peanuts, soy, gluten, tree nuts

### Files Changed
- `backend/internal/coconut/detect.go` — configurable keywords from env
- `backend/internal/ingest/scheduler.go` — Progress struct + atomic
- `backend/internal/ingest/off.go` — ProgressFunc, counting reader, remove category filter, configurable country
- `backend/internal/api/routes.go` — progress in health response
- `backend/main.go` — wire progress func
- `Dockerfile` — bake ENV defaults
- `frontend/src/api/client.ts` — HealthResponse type
- `frontend/src/components/SplashScreen.tsx` — loading bar + phase text
- `docs/DEPLOYMENT.md` — NEW
- `docs/OTHER_ALLERGIES.md` — NEW

## 2026-03-25 — Unified "cocoNot vision" Lens

### Problem
Barcode scanning and OCR ingredient reading were split into two separate camera modes with two footer buttons. Users had to choose which detection to run, adding friction.

### Solution
Consolidated into a single "cocoNot vision" button that runs both barcode detection and OCR concurrently at 1s intervals:
- Barcode detection (hardware-accelerated BarcodeDetector API, ~5ms) and OCR (Tesseract.js Web Worker) run in parallel each tick via `Promise.all`
- OCR slowed from 200ms → 1000ms intervals (less aggressive, matches barcode cadence)
- OCR backpressure: skips OCR tick if previous call still running (prevents pile-up on slow phones)
- Only coconut OCR matches shown in overlay (non-coconut word boxes were noise)
- Unified draw function renders both barcode hitboxes (product name/status chips) and OCR coconut hits
- OCR worker self-heals if it crashes mid-session
- Single `#f51c99` footer button replaces two separate buttons

### Performance
Totally fine — barcode detection is nearly free (native API), OCR runs on a separate worker thread. No resource contention. At 1s intervals, battery impact is modest.

### Files changed
- `frontend/src/components/BarcodeScanner.tsx` — consolidated from 691 → ~530 lines

## 2026-03-25 — Parallelize Product Ingestion

### Problem
Upserting ~800K products into PostgreSQL took 15-25 minutes due to sequential per-product SQL round-trips (~2-4 queries each = ~2M total round-trips).

### Solution
Replaced the sequential upsert loop with a chunked worker pool + `pgx.Batch` pipeline:

1. **Pre-compute phase**: Coconut detection, category classification, field normalization, and SKU deduplication done up front (pure CPU, fast)
2. **Chunk into batches of 1000** products each
3. **8 worker goroutines** via `errgroup` process chunks in parallel
4. **Per chunk** (3 round-trips instead of ~3000):
   - Bulk `SELECT ... WHERE sku = ANY($1)` to find existing products
   - Bulk `SELECT ... WHERE product_id = ANY($1)` to find user flags
   - `pgx.Batch` pipelines all INSERT/UPDATE/UPSERT writes in a single transaction
5. Atomic progress counter for thread-safe progress reporting

### Expected speedup
- Old: 800K × 2-4 sequential round-trips = ~2M SQL operations → 15-25 min
- New: 800 chunks × 3 pipelined round-trips, 8 workers → estimated 30-90 sec

### Files changed
- `backend/internal/ingest/off.go` — new `prepareProducts()`, `processChunk()`, chunked `upsertProducts()` with errgroup worker pool
