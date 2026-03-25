package ingest

import (
	"context"
	"log"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Progress tracks the current ingestion phase and progress.
type Progress struct {
	Phase   string `json:"phase"`   // "idle" | "downloading" | "querying" | "upserting"
	Current int64  `json:"current"` // bytes downloaded OR products upserted
	Total   int64  `json:"total"`   // Content-Length OR product count
}

// Scheduler runs periodic ingestion in the background.
type Scheduler struct {
	pool     *pgxpool.Pool
	dataDir  string
	interval time.Duration
	running  atomic.Bool
	ready    atomic.Bool
	progress atomic.Value // stores *Progress
}

// NewScheduler creates a scheduler that runs ingestion every interval.
func NewScheduler(pool *pgxpool.Pool, dataDir string, interval time.Duration) *Scheduler {
	s := &Scheduler{
		pool:     pool,
		dataDir:  dataDir,
		interval: interval,
	}
	s.progress.Store(&Progress{Phase: "idle"})
	return s
}

// Ready reports whether the first ingestion has completed.
func (s *Scheduler) Ready() bool {
	return s.ready.Load()
}

// Progress returns the current ingestion progress.
func (s *Scheduler) GetProgress() *Progress {
	if p, ok := s.progress.Load().(*Progress); ok {
		return p
	}
	return &Progress{Phase: "idle"}
}

func (s *Scheduler) setProgress(phase string, current, total int64) {
	s.progress.Store(&Progress{Phase: phase, Current: current, Total: total})
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
	if err := RunOFF(ctx, s.pool, s.dataDir, s.setProgress); err != nil {
		log.Printf("Scheduled ingestion failed: %v", err)
		s.setProgress("idle", 0, 0)
		return
	}
	s.setProgress("idle", 0, 0)
	log.Printf("Scheduled ingestion complete in %s", time.Since(start).Round(time.Second))
}
