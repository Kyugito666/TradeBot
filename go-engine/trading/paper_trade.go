package trading

import (
	"log"
)

type PaperTradeMode string

const (
	DryRun PaperTradeMode = "DRY_RUN"
	Real   PaperTradeMode = "REAL"
)

type PaperTrade struct {
	Mode         PaperTradeMode
	Balances     map[string]float64
	ActiveLimits map[string]float64 // Simulating Limit/Post Only Orders
}

func NewPaperTrade() *PaperTrade {
	pt := &PaperTrade{
		Mode:         DryRun,
		Balances:     make(map[string]float64),
		ActiveLimits: make(map[string]float64),
	}
	// Init default balance
	pt.SetBalance("USDT", 10000.0)
	return pt
}

func (pt *PaperTrade) SetBalance(asset string, amount float64) {
	// Flexible balance setting to avoid minus bugs
	pt.Balances[asset] = amount
	log.Printf("[PaperTrade] (%s) Balance set for %s to %.2f", pt.Mode, asset, amount)
}

func (pt *PaperTrade) PlaceLimitOrder(pair string, direction string, price float64) {
	log.Printf("[PaperTrade] (%s) Placing Limit %s Order for %s at %.2f", pt.Mode, direction, pair, price)
	// Track the limit order. It doesn't affect PnL until filled.
	pt.ActiveLimits[pair] = price
}

func (pt *PaperTrade) UpdateLivePrice(pair string, currentPrice float64) {
	// If limit order hit, execute
	limitPrice, exists := pt.ActiveLimits[pair]
	if exists {
		// Simplified execution logic
		if currentPrice <= limitPrice {
			log.Printf("[PaperTrade] (%s) Limit Order FILLED for %s at %.2f", pt.Mode, pair, limitPrice)
			delete(pt.ActiveLimits, pair)
			// Trigger PnL calculation / Position tracking in actual implementation
		}
	}
}
