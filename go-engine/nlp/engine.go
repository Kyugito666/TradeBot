// go-engine/nlp/engine.go
//
// NLP Engine Orchestrator
// =======================
// Goroutine yang menjalankan siklus scrape → score → update SHM setiap interval.
// Dipanggil dari main.go sebagai goroutine tunggal.
//
// Arsitektur:
//   main.go
//     └─ go nlpEngine.Run(ctx, feed)          ← entry point
//          ├── FetchLatestNews(symbol, 20)     ← scraper.go
//          ├── scorer.ScoreCorpus(headlines)   ← scorer.go
//          └── feed.UpdateSentiment(score, n)  ← market/feed.go → SHM → linguist.rs
//
// Default interval: 5 menit (configurable via NLPInterval).
// Identik dengan goroutine yang di-comment di main.go step 5.

package nlp

import (
	"context"
	"log"
	"time"
)

// SentimentUpdater adalah interface kecil yang harus dipenuhi oleh market.Feed.
// Ini memungkinkan nlp package tidak bergantung langsung ke market package
// (menghindari circular import).
type SentimentUpdater interface {
	UpdateSentiment(score float32, count uint32)
}

// Engine adalah orchestrator NLP yang menjaga siklus fetch-score-update.
type Engine struct {
	symbol   string
	interval time.Duration
	scorer   *HybridScorer
}

// NewEngine membuat NLP Engine baru.
//
//   symbol  : ticker crypto, contoh "SOLUSDT"
//   interval: seberapa sering scrape dilakukan, default 5 menit
func NewEngine(symbol string, interval time.Duration) *Engine {
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return &Engine{
		symbol:   symbol,
		interval: interval,
		scorer:   NewHybridScorer(),
	}
}

// Run memulai goroutine NLP. Blokir sampai ctx di-cancel.
// Dipanggil dari main.go:  go nlpEngine.Run(mainCtx, feed)
func (e *Engine) Run(ctx context.Context, feed SentimentUpdater) {
	log.Printf("[NLP] Engine dimulai — symbol=%s interval=%s", e.symbol, e.interval)

	// Jalankan sekali langsung saat startup (tanpa menunggu interval pertama)
	e.runOnce(feed)

	ticker := time.NewTicker(e.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("[NLP] Engine berhenti (context cancelled)")
			return
		case <-ticker.C:
			e.runOnce(feed)
		}
	}
}

// runOnce menjalankan satu siklus lengkap: scrape → score → update.
func (e *Engine) runOnce(feed SentimentUpdater) {
	start := time.Now()

	// 1. Scrape headlines
	headlines := FetchLatestNews(e.symbol, 20)
	if len(headlines) == 0 {
		log.Printf("[NLP] Tidak ada headline — skip scoring")
		// Tetap update SHM dengan score 0, count 0 agar linguist tidak stuck
		feed.UpdateSentiment(0, 0)
		return
	}

	// 2. Score corpus
	stats, _ := e.scorer.ScoreCorpus(headlines)

	// 3. Update SHM via Feed interface
	score := float32(stats.MeanScore)
	count := uint32(stats.NBullish + stats.NBearish + stats.NNeutral)
	feed.UpdateSentiment(score, count)

	log.Printf(
		"[NLP] Siklus selesai dalam %dms | %d headlines | score=%.4f | %s | keywords=%v",
		time.Since(start).Milliseconds(),
		count,
		stats.MeanScore,
		stats.FearGreed,
		stats.TopKeywords,
	)
}
