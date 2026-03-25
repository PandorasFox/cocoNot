# CoconutFree — Implementation Plan

## Overview
Mobile-first web app to help filter out frozen dairy treats (ice cream, gelato, sorbet, etc.) that contain coconut, for someone with a severe coconut allergy. This is a **filtering tool, not a source of truth** — it helps quickly eliminate the definitely-dangerous stuff so you know what's worth checking the label on.

## Mental Model
Two categories only:
- **CONTAINS COCONUT** — high confidence this is dangerous. Skip it.
- **POSSIBLY CLEAN (as of DATE)** — no coconut found in our data as of this date. **Always check the label before buying.**

This tool filters OUT the dangerous. It never certifies anything as safe.

## Tech Stack
- **Frontend:** React (Vite + TypeScript), mobile-first responsive, TailwindCSS
- **Backend:** Go (stdlib `net/http` + chi router)
- **Database:** PostgreSQL 16 (in-container)
- **Deployment:** Docker Compose (Go app + Postgres in one compose stack)

## Architecture

```
┌─────────────────────────────────────────────┐
│  Docker Compose                             │
│                                             │
│  ┌──────────────┐    ┌──────────────────┐   │
│  │  Go Server   │───▶│  PostgreSQL 16   │   │
│  │  :8080       │    │  :5432           │   │
│  │              │    │                  │   │
│  │  - API       │    │  - products      │   │
│  │  - Static    │    │  - ingredients   │   │
│  │    frontend  │    │  - flags         │   │
│  │  - Scraper   │    │  - change_log    │   │
│  │    jobs      │    │                  │   │
│  └──────────────┘    └──────────────────┘   │
└─────────────────────────────────────────────┘
```

Go server serves the built React frontend as static files. No separate frontend container.

## Database Schema (v1)

### `products`
Core product table, one row per SKU.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| sku | text | UPC/EAN barcode, unique |
| brand | text | e.g. "Ben & Jerry's" |
| name | text | e.g. "Cherry Garcia" |
| category | text | ice_cream, gelato, sorbet, frozen_yogurt, other |
| image_url | text | nullable |
| contains_coconut | boolean | resolved value — true = CONTAINS COCONUT |
| status_as_of | timestamptz | when status was last confirmed/updated |
| created_at | timestamptz | |
| updated_at | timestamptz | |

No "safe" boolean. `contains_coconut = false` means "possibly clean as of status_as_of". That's it.

### `ingredient_sources`
Each data source gets its own row per product. Multiple sources per product.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| product_id | uuid | FK -> products |
| source_type | text | 'openfoodfacts', 'scraper', 'user_flag', 'manual' |
| source_url | text | nullable, where we got it |
| ingredients_raw | text | full ingredients text as scraped |
| coconut_found | boolean | did this source find coconut? |
| confidence | text | 'high', 'medium', 'low' |
| fetched_at | timestamptz | when this data was retrieved |
| created_at | timestamptz | |

### `user_flags`
User-submitted corrections. **User flags for coconut presence always take priority** (false negatives are dangerous).

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| product_id | uuid | FK -> products |
| flag_type | text | 'found_coconut', 'wrong_ingredients', 'other' |
| notes | text | optional user explanation |
| photo_url | text | nullable, photo of label |
| resolved | boolean | has this been reviewed? |
| created_at | timestamptz | |

### `status_changelog`
Tracks every time a product's coconut status changes. Powers the "recently reclassified" view.

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK |
| product_id | uuid | FK -> products |
| old_contains_coconut | boolean | |
| new_contains_coconut | boolean | |
| reason | text | what triggered the change |
| changed_at | timestamptz | |

## Coconut Detection & Resolution Logic

Priority order (highest to lowest):
1. **User flag: found_coconut** — always wins. Someone saw it on the label. Mark contains_coconut = true.
2. **Any ingredient source** with coconut_found = true — if ANY source says coconut, it contains coconut.
3. **All sources agree** no coconut found — mark contains_coconut = false (possibly clean as of now).
4. **No data** — contains_coconut = NULL (show as "no data — check label").

Coconut keyword matching in ingredients text:
- `coconut` (covers coconut oil, coconut milk, coconut cream, coconut water, etc.)
- `cocos nucifera` (botanical name, appears in some ingredient lists)
- `copra`

Principle: **one positive from any source = contains coconut. Period.**

## API Endpoints (v1)

```
GET  /api/products              — list/search products (query, brand, filters)
GET  /api/products/:id          — single product detail with all sources + flags
GET  /api/products/barcode/:sku — lookup by UPC barcode
GET  /api/products/reclassified — recently changed coconut status
POST /api/products/:id/flag     — submit a user flag
GET  /api/search?q=             — fuzzy search by brand + name (pg_trgm)
```

## Frontend Pages (v1)

1. **Home / Search** — search bar + barcode scan button, filter toggle (show/hide "contains coconut" items)
2. **Product List** — color-coded cards:
   - Red: **CONTAINS COCONUT** — skip
   - Amber/neutral: **POSSIBLY CLEAN (as of DATE)** — check the label
   - Gray: **NO DATA** — definitely check the label
3. **Product Detail** — full ingredients from all sources, status history timeline, flag button, "last checked DATE"
4. **Recently Reclassified** — products that flipped status recently (the watch list)
5. **Scan** — camera barcode scanner (zxing-js)

Every screen shows a persistent reminder: *"Always check the label. This tool helps filter — it is not a guarantee."*

## Implementation Phases

### Phase 1: Foundation (this session)
- [ ] Project scaffolding (Go module, React/Vite app, Docker Compose, Dockerfile)
- [ ] Database schema + migrations
- [ ] Basic CRUD API for products
- [ ] React shell with routing + mobile layout
- [ ] Product list + search page
- [ ] Product detail page

### Phase 2: Data Ingestion
- [ ] Open Food Facts API client (frozen desserts category)
- [ ] Coconut detection in ingredients text
- [ ] Import pipeline: OFF -> ingredient_sources -> resolve product status
- [ ] Basic web scraper framework for grocery sites

### Phase 3: User Features
- [ ] User flagging (report found coconut)
- [ ] Status changelog + "recently reclassified" view
- [ ] Barcode scanning via camera
- [ ] Fuzzy search with pg_trgm

### Phase 4: Polish
- [ ] PWA support (installable, cached product data)
- [ ] Photo upload for label verification
- [ ] Admin review for flags

## Key Dependencies (Go)
- `github.com/go-chi/chi/v5` — router
- `github.com/jackc/pgx/v5` — Postgres driver
- `github.com/golang-migrate/migrate/v4` — DB migrations
- `github.com/google/uuid` — UUIDs

## Key Dependencies (Frontend)
- `react` + `react-dom` + `react-router-dom`
- `@zxing/library` — barcode scanning
- `tailwindcss` — mobile-first styling

## Project Structure
```
coconutfree/
├── CLAUDE.md
├── DEVLOG.md
├── PLAN.md
├── docker-compose.yml
├── Dockerfile
├── backend/
│   ├── go.mod
│   ├── go.sum
│   ├── main.go
│   ├── internal/
│   │   ├── api/          # HTTP handlers
│   │   ├── db/           # Database queries + connection
│   │   ├── models/       # Data types
│   │   ├── scraper/      # OFF client + web scrapers
│   │   └── coconut/      # Coconut detection logic
│   └── migrations/       # SQL migration files
└── frontend/
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── pages/
        ├── components/
        └── api/          # API client
```
