// go-engine/market/state.go
//
// Exported snapshot of the Feed's internal state for use by the orchestrator.
// Kept in a separate file to avoid polluting feed.go with orchestrator concerns.

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
}

// State returns a safe copy of the current feed state.
// Acquires a read-lock; safe to call from any goroutine.
func (f *Feed) State() StateSnapshot {
	f.state.mu.RLock()
	defer f.state.mu.RUnlock()
	return StateSnapshot{
		Symbol:         f.state.Symbol,
		Price:          f.state.Price,
		OI:             f.state.OI,
		LSR:            f.state.LSR,
		ATR14:          f.state.ATR14,
		FundingRate:    f.state.FundingRate,
		SentimentScore: f.state.SentimentScore,
		NewsCount:      f.state.NewsCount,
	}
}
