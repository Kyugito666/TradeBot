// go-engine/exchange/mexc/adapter.go
//
// Implements the generic Execute(ctx, interface{}) signature expected by
// main.go's orderExec interface.

package mexc

import (
	"context"
	"fmt"
)

func (e *Executor) Execute(ctx context.Context, req interface{}) error {
	m, ok := req.(map[string]interface{})
	if !ok {
		if or, ok2 := req.(OrderRequest); ok2 {
			return e.executeOrder(ctx, or)
		}
		return fmt.Errorf("mexc.Execute: unexpected req type %T", req)
	}
	side := strVal(m, "Side")
	or := OrderRequest{
		Symbol:     strVal(m, "Symbol"),
		Side:       side,
		Entry:      f64Val(m, "Entry"),
		TakeProfit: f64Val(m, "TakeProfit"),
		StopLoss:   f64Val(m, "StopLoss"),
		RiskReward: f64Val(m, "RiskReward"),
		Confidence: f64Val(m, "Confidence"),
	}
	return e.executeOrder(ctx, or)
}

func (e *Executor) executeOrder(ctx context.Context, req OrderRequest) error {
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
