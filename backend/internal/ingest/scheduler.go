package ingest

import (
	"context"
	"log"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Scheduler runs periodic ingestion in the background.
type Scheduler struct {
	pool     *pgxpool.Pool
	dataDir  string
	interval time.Duration
	running  atomic.Bool
	ready    atomic.Bool
}

// NewScheduler creates a scheduler that runs ingestion every interval.
func NewScheduler(pool *pgxpool.Pool, dataDir string, interval time.Duration) *Scheduler {
	return &Scheduler{
		pool:     pool,
		dataDir:  dataDir,
		interval: interval,
	}
}

// Ready reports whether the first ingestion has completed.
func (s *Scheduler) Ready() bool {
	return s.ready.Load()
}

// Start begins the periodic ingestion loop. Runs one ingestion immediately
// on startup, then repeats on the configured interval. Blocks until ctx is
// cancelled.
func (s *Scheduler) Start(ctx context.Context) {
	s.runOnce(ctx)
	s.ready.Store(true)

	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("Ingest scheduler shutting down")
			return
		case <-ticker.C:
			s.runOnce(ctx)
		}
	}
}

func (s *Scheduler) runOnce(ctx context.Context) {
	if !s.running.CompareAndSwap(false, true) {
		log.Println("Ingest already running, skipping")
		return
	}
	defer s.running.Store(false)

	log.Println("Scheduled ingestion starting...")
	start := time.Now()
	if err := RunOFF(ctx, s.pool, s.dataDir); err != nil {
		log.Printf("Scheduled ingestion failed: %v", err)
		return
	}
	log.Printf("Scheduled ingestion complete in %s", time.Since(start).Round(time.Second))
}
