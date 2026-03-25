# Deployment Guide

## Quick Start

Single command with Docker:

```bash
docker run -d \
  -p 8080:8080 \
  -v pgdata:/var/lib/postgresql/data \
  -v offdata:/data \
  ghcr.io/<owner>/coconutfree:latest
```

The container starts PostgreSQL, runs migrations, downloads the Open Food Facts database, and serves the app on port 8080.

## Docker Compose (Minimal)

```yaml
services:
  app:
    image: ghcr.io/<owner>/coconutfree:latest
    ports:
      - "8080:8080"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - offdata:/data

volumes:
  pgdata:
  offdata:
```

Override only what differs from defaults:

```yaml
    environment:
      - INGEST_COUNTRIES=   # empty = all countries
      - ALLERGEN_KEYWORDS=peanut,arachis hypogaea,groundnut
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `DATA_DIR` | `/data` | Parquet download + cache directory |
| `INGEST_INTERVAL` | `6h` | How often to re-ingest from OFF |
| `INGEST_COUNTRIES` | `en:united-states` | OFF country tag filter. Set to `-` for all countries. |
| `ALLERGEN_KEYWORDS` | `coconut,cocos nucifera,copra` | Comma-separated allergen keywords for detection |
| `DATABASE_URL` | `postgres://coconutfree:coconutfree@localhost:5432/coconutfree?sslmode=disable` | PostgreSQL connection string |
| `FRONTEND_DIR` | `/app/static` | Built frontend assets directory |
| `MIGRATIONS_DIR` | `file:///app/migrations` | SQL migrations path |

## Volume Mounts

| Volume | Container Path | Purpose |
|---|---|---|
| `pgdata` | `/var/lib/postgresql/data` | PostgreSQL data (persists across restarts) |
| `offdata` | `/data` | Parquet file cache (skips re-download if <24h old) |

## CI/CD

The Docker image is auto-published to GitHub Container Registry on every push to `main` via GitHub Actions. Tags:

- `latest` — always points to the most recent build
- `sha-<short-hash>` — pinned to a specific commit
