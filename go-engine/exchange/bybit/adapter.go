// go-engine/exchange/bybit/adapter.go
//
// Implements the generic Execute(ctx, interface{}) signature expected by
// main.go's orderExec interface. Unwraps the neutral map and delegates
// to the type-safe Execute(ctx, OrderRequest) method.

package bybit

import (
	"context"
	"fmt"
)

// Execute satisfies the tradebot/go-engine main.orderExec interface.
// The `req` parameter is expected to be a map[string]interface{} produced by
// main.buildOrderRequest; we convert it to an OrderRequest here.
func (e *Executor) Execute(ctx context.Context, req interface{}) error {
	m, ok := req.(map[string]interface{})
	if !ok {
		// Already an OrderRequest (future path)
		if or, ok2 := req.(OrderRequest); ok2 {
			return e.ExecuteOrder(ctx, or)
		}
		return fmt.Errorf("bybit.Execute: unexpected req type %T", req)
	}
	or := OrderRequest{
		Symbol:     strVal(m, "Symbol"),
		Side:       sideStr(strVal(m, "Side")),
		Entry:      f64Val(m, "Entry"),
		TakeProfit: f64Val(m, "TakeProfit"),
		StopLoss:   f64Val(m, "StopLoss"),
		RiskReward: f64Val(m, "RiskReward"),
		Confidence: f64Val(m, "Confidence"),
	}
	return e.ExecuteOrder(ctx, or)
}

// ExecuteOrder is the clean typed entry point, keeping the original Execute()
// name for internal use. The Executor's original Execute() in executor.go is
// renamed here to avoid conflict.
func (e *Executor) ExecuteOrder(ctx context.Context, req OrderRequest) error {
	return e.execute(ctx, req)
}

func strVal(m map[string]interface{}, k string) string {
	if v, ok := m[k].(string); ok {
		return v
	}
	return ""
}

func f64Val(m map[string]interface{}, k string) float64 {
	if v, ok := m[k].(float64); ok {
		return v
	}
	return 0
}

// sideStr normalises "BUY"→"Buy" and "SELL"→"Sell" for Bybit API.
func sideStr(s string) string {
	switch s {
	case "BUY", "Buy":
		return "Buy"
	case "SELL", "Sell":
		return "Sell"
	default:
		return s
	}
}
