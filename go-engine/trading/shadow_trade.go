package trading

import (
	"log"
)

// ShadowTrade acts as a background forward-tester without disturbing the paper trade.
type ShadowTrade struct {
	ActivePositions map[string]float64
}

func NewShadowTrade() *ShadowTrade {
	return &ShadowTrade{
		ActivePositions: make(map[string]float64),
	}
}

// ExecuteShadow executes a trade silently in the background.
func (st *ShadowTrade) ExecuteShadow(pair string, direction string, price float64) {
	log.Printf("[ShadowTrade] Executing %s on %s @ %.2f", direction, pair, price)
	
	// Simulate tracking position
	if direction == "LONG" {
		st.ActivePositions[pair] = price
	} else if direction == "SHORT" {
		st.ActivePositions[pair] = -price
	}
}

// Evaluate performance to be fed to Tab Consensus / Filter
func (st *ShadowTrade) EvaluateShadowPnL(currentPrice float64) float64 {
	// Dummy calculation
	return 0.0
}
