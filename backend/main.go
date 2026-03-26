package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/golang-migrate/migrate/v4"
	pgxMigrate "github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"

	"github.com/hecate/coconutfree/internal/api"
	"github.com/hecate/coconutfree/internal/cache"
	"github.com/hecate/coconutfree/internal/db"
	"github.com/hecate/coconutfree/internal/ingest"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Connect to database
	pool, err := db.Connect(ctx)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer pool.Close()

	// Run migrations
	if err := runMigrations(pool); err != nil {
		log.Fatalf("Failed to run migrations: %v", err)
	}

	// Subcommands
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "ingest":
			dataDir := os.Getenv("DATA_DIR")
			if dataDir == "" {
				dataDir = "/data"
			}
			prepared, err := ingest.RunOFF(ctx, dataDir, nil)
			if err != nil {
				log.Fatalf("Ingestion failed: %v", err)
			}
			// Build cache
			cacheProducts := make([]cache.PreparedProduct, len(prepared))
			for i, p := range prepared {
				cacheProducts[i] = cache.PreparedProduct{
					Code:            p.Code,
					Name:            p.Name,
					ContainsCoconut: p.ContainsCoconut,
				}
			}
			c, err := cache.Build(cacheProducts)
			if err != nil {
				log.Fatalf("Cache build failed: %v", err)
			}
			cachePath := filepath.Join(dataDir, "skus.json.gz")
			if err := c.WriteFile(cachePath); err != nil {
				log.Fatalf("Cache write failed: %v", err)
			}
			log.Printf("Cache written to %s", cachePath)
			// Upsert into database
			if err := ingest.UpsertProducts(ctx, pool, prepared, nil); err != nil {
				log.Fatalf("Database upsert failed: %v", err)
			}
			return
		default:
			log.Fatalf("Unknown command: %s (available: ingest)", os.Args[1])
		}
	}

	// Start periodic ingestion if DATA_DIR is set (volume mounted)
	var sched *ingest.Scheduler
	dataDir := os.Getenv("DATA_DIR")
	if dataDir != "" {
		interval := 6 * time.Hour
		if v := os.Getenv("INGEST_INTERVAL"); v != "" {
			if d, err := time.ParseDuration(v); err == nil && d > 0 {
				interval = d
			} else {
				log.Printf("Invalid INGEST_INTERVAL %q, using default %s", v, interval)
			}
		}
		sched = ingest.NewScheduler(pool, dataDir, interval)

		// Try to pre-load cache from disk for instant readiness
		cachePath := filepath.Join(dataDir, "skus.json.gz")
		if c, err := cache.LoadFile(cachePath); err == nil {
			sched.SetCache(c)
			log.Printf("Pre-loaded cache from %s (%d entries)", cachePath, c.Count())
		} else {
			log.Printf("No pre-built cache found at %s, will build on first ingest", cachePath)
		}

		go sched.Start(ctx)
		log.Printf("Ingest scheduler started (interval: %s)", interval)
	}

	queries := db.NewQueries(pool)
	readyFunc := func() bool { return true }
	progressFunc := func() *ingest.Progress { return &ingest.Progress{Phase: "idle"} }
	cacheFunc := func() *cache.Cache { return nil }
	if sched != nil {
		readyFunc = sched.Ready
		progressFunc = sched.GetProgress
		cacheFunc = sched.GetCache
	}
	router := api.NewRouter(queries, cacheFunc, readyFunc, progressFunc)

	// Serve frontend static files
	frontendDir := os.Getenv("FRONTEND_DIR")
	if frontendDir == "" {
		frontendDir = filepath.Join(".", "static")
	}
	if _, err := os.Stat(frontendDir); err == nil {
		fs := http.FileServer(http.Dir(frontendDir))
		router.Handle("/*", spaHandler(fs, frontendDir))
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		<-sigCh
		log.Println("Shutting down...")
		cancel()
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		srv.Shutdown(shutdownCtx)
	}()

	log.Printf("CocoNot server starting on :%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

func runMigrations(pool *pgxpool.Pool) error {
	sqlDB := stdlib.OpenDBFromPool(pool)

	driver, err := pgxMigrate.WithInstance(sqlDB, &pgxMigrate.Config{})
	if err != nil {
		return fmt.Errorf("creating migration driver: %w", err)
	}

	migrationsDir := os.Getenv("MIGRATIONS_DIR")
	if migrationsDir == "" {
		migrationsDir = "file://migrations"
	}

	m, err := migrate.NewWithDatabaseInstance(migrationsDir, "postgres", driver)
	if err != nil {
		return fmt.Errorf("creating migrator: %w", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("running migrations: %w", err)
	}

	log.Println("Migrations complete")
	return nil
}

// spaHandler serves the SPA — returns index.html for any path that doesn't match a static file.
func spaHandler(fileServer http.Handler, dir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := filepath.Join(dir, r.URL.Path)
		if _, err := os.Stat(path); os.IsNotExist(err) {
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		fileServer.ServeHTTP(w, r)
	}
}
