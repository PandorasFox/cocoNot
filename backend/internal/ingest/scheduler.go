package ingest

import (
	"context"
	"log"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/hecate/coconutfree/internal/cache"
)

// Progress tracks the current ingestion phase and progress.
type Progress struct {
	Phase   string `json:"phase"`   // "idle" | "downloading" | "querying" | "caching"
	Current int64  `json:"current"`
	Total   int64  `json:"total"`
}

// Scheduler runs periodic ingestion in the background.
type Scheduler struct {
	dataDir  string
	interval time.Duration
	running  atomic.Bool
	ready    atomic.Bool
	progress atomic.Value // stores *Progress
	cache    atomic.Pointer[cache.Cache]
}

// NewScheduler creates a scheduler that runs ingestion every interval.
func NewScheduler(dataDir string, interval time.Duration) *Scheduler {
	s := &Scheduler{
		dataDir:  dataDir,
		interval: interval,
	}
	s.progress.Store(&Progress{Phase: "idle"})
	return s
}

// Ready reports whether the cache is available.
func (s *Scheduler) Ready() bool {
	return s.ready.Load()
}

// GetProgress returns the current ingestion progress.
func (s *Scheduler) GetProgress() *Progress {
	if p, ok := s.progress.Load().(*Progress); ok {
		return p
	}
	return &Progress{Phase: "idle"}
}

// GetCache returns the current SKU cache, or nil if not yet built.
func (s *Scheduler) GetCache() *cache.Cache {
	return s.cache.Load()
}

// SetCache sets the cache (used for pre-loading from disk on startup).
func (s *Scheduler) SetCache(c *cache.Cache) {
	s.cache.Store(c)
	s.ready.Store(true)
}

func (s *Scheduler) setProgress(phase string, current, total int64) {
	s.progress.Store(&Progress{Phase: phase, Current: current, Total: total})
}

func (s *Scheduler) cachePath() string {
	return filepath.Join(s.dataDir, "skus.json.gz")
}

// Start begins the periodic ingestion loop.
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
	if !NeedsIngest(s.dataDir) {
		log.Println("No new data to ingest, skipping")
		return
	}

	if !s.running.CompareAndSwap(false, true) {
		log.Println("Ingest already running, skipping")
		return
	}
	defer s.running.Store(false)

	log.Println("Scheduled ingestion starting...")
	start := time.Now()

	prepared, err := RunOFF(ctx, s.dataDir, s.setProgress)
	if err != nil {
		log.Printf("Scheduled ingestion failed: %v", err)
		s.setProgress("idle", 0, 0)
		return
	}

	s.setProgress("caching", 0, int64(len(prepared)))
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
		log.Printf("Cache build failed: %v", err)
		s.setProgress("idle", 0, 0)
		return
	}

	if err := c.WriteFile(s.cachePath()); err != nil {
		log.Printf("Cache write failed: %v", err)
	} else {
		s.cache.Store(c)
		log.Printf("Cache written: %s", s.cachePath())
	}

	s.setProgress("idle", 0, 0)
	log.Printf("Scheduled ingestion complete in %s", time.Since(start).Round(time.Second))
}
