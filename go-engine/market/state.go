// go-engine/market/state.go
//
// Exported snapshot of the Feed's internal state for use by the orchestrator.
// Kept in a separate file to avoid polluting feed.go with orchestrator concerns.
//
// [FIX-STATE] Symbol field dihapus dari State struct di feed.go (FIX-F1):
//   f.state.Symbol → TIDAK ADA → compile error
//   FIX: gunakan f.getSymbol() (atomic.Value, thread-safe) untuk mengisi
//   StateSnapshot.Symbol saat State() dipanggil dari main.go.

package market

// StateSnapshot is a point-in-time copy of all Feed scalars.
// Called by main.go once per signal cycle to build bot_insight.json.
type StateSnapshot struct {
	Symbol         string
	Price          float64
	OI             float64
	LSR            float64
	ATR14          float64
	FundingRate    float64
	SentimentScore float32
	NewsCount      uint32
	Pct24h         float64
}

// State returns a safe copy of the current feed state.
// Acquires a read-lock; safe to call from any goroutine.
//
// [FIX-STATE] Symbol TIDAK lagi ada di f.state (sudah dipindah ke
// f.atomicSymbol di FIX-F1). Gunakan f.getSymbol() yang thread-safe
// via atomic.Value — tidak perlu masuk ke dalam read-lock State.
func (f *Feed) State() StateSnapshot {
	// [FIX-STATE] Ambil symbol SEBELUM lock (atomic, tidak butuh mutex)
	sym := f.getSymbol()

	f.state.mu.RLock()
	defer f.state.mu.RUnlock()
	return StateSnapshot{
		Symbol:         sym, // [FIX-STATE] WAS: f.state.Symbol → compile error
		Price:          f.state.Price,
		OI:             f.state.OI,
		LSR:            f.state.LSR,
		ATR14:          f.state.ATR14,
		FundingRate:    f.state.FundingRate,
		SentimentScore: f.state.SentimentScore,
		NewsCount:      f.state.NewsCount,
		Pct24h:         f.state.Pct24h,
	}
}
