// go-engine/exchange/mexc/executor.go
//
// MEXC Futures Executor
// =====================
// MEXC uses Hedge Mode (two-sided position) and requires separate
// TP/SL orders submitted AFTER the entry order fills (unlike Bybit which
// accepts embedded TP/SL at order creation).
//
// positionType: 1 = Long,  2 = Short
// openType:     1 = Isolated, 2 = Cross

package mexc

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"time"
)

const (
	mexcBase   = "https://contract.mexc.com"
	mexcRECVWN = "5000"
)

type Config struct {
	APIKey    string
	APISecret string
	DryRun    bool
	Leverage  int
	RiskPct   float64
}

type OrderRequest struct {
	Symbol     string
	Side       string // "BUY" | "SELL"
	Entry      float64
	TakeProfit float64
	StopLoss   float64
	RiskReward float64
	Confidence float64
}

type Executor struct {
	cfg    Config
	client *http.Client
}

func New(cfg Config) *Executor {
	return &Executor{cfg: cfg, client: &http.Client{Timeout: 10 * time.Second}}
}

func (e *Executor) Execute(ctx context.Context, req OrderRequest) error {
	log.Printf("[MEXC] ── %s %s ────────────────────────", req.Side, req.Symbol)
	log.Printf("[MEXC] entry=%.4f TP=%.4f SL=%.4f RR=%.2f", req.Entry, req.TakeProfit, req.StopLoss, req.RiskReward)

	if e.cfg.DryRun {
		log.Printf("[MEXC] DRY RUN — skipped")
		return nil
	}

	freeUSDT, err := e.fetchBalance(ctx)
	if err != nil { return fmt.Errorf("balance: %w", err) }

	stopDist := math.Abs(req.Entry - req.StopLoss)
	if stopDist < 1e-8 { return fmt.Errorf("degenerate SL") }
	riskUSDT := freeUSDT * e.cfg.RiskPct
	rawSize  := riskUSDT / stopDist
	size     := math.Round(rawSize*1000) / 1000 // 3dp

	isLong       := req.Side == "BUY"
	posType      := 1
	if !isLong { posType = 2 }
	exitSide := "SELL"
	if !isLong { exitSide = "BUY" }

	// Set leverage first
	if err := e.setLeverage(ctx, req.Symbol, posType, e.cfg.Leverage); err != nil {
		log.Printf("[MEXC] leverage warn: %v", err)
	}

	// ── Entry order ──────────────────────────────────────────────────────
	entryBody := map[string]interface{}{
		"symbol":       req.Symbol,
		"side":         req.Side,
		"orderType":    "5", // 5 = Limit
		"openType":     1,   // Isolated
		"positionType": posType,
		"price":        fmt.Sprintf("%.4f", req.Entry),
		"vol":          size,
		"leverage":     e.cfg.Leverage,
	}
	entryResp, err := e.signedPost(ctx, "/api/v1/private/order/create", entryBody)
	if err != nil { return fmt.Errorf("entry order: %w", err) }
	var entryResult struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    string `json:"data"` // orderId
	}
	if err := json.Unmarshal(entryResp, &entryResult); err != nil { return err }
	if !entryResult.Success { return fmt.Errorf("MEXC entry: %s", entryResult.Message) }
	log.Printf("[MEXC] Entry order id=%s", entryResult.Data)

	// ── SL trigger order ─────────────────────────────────────────────────
	slBody := map[string]interface{}{
		"symbol":       req.Symbol,
		"side":         exitSide,
		"orderType":    "6",  // 6 = stop limit (trigger)
		"openType":     1,
		"positionType": posType,
		"price":        fmt.Sprintf("%.4f", req.StopLoss*0.999),
		"triggerPrice": fmt.Sprintf("%.4f", req.StopLoss),
		"vol":          size,
		"reduceOnly":   true,
	}
	if _, err := e.signedPost(ctx, "/api/v1/private/order/create", slBody); err != nil {
		log.Printf("[MEXC] SL order failed: %v", err)
	} else {
		log.Printf("[MEXC] SL order placed @ %.4f", req.StopLoss)
	}

	// ── TP trigger order ─────────────────────────────────────────────────
	tpBody := map[string]interface{}{
		"symbol":       req.Symbol,
		"side":         exitSide,
		"orderType":    "6",
		"openType":     1,
		"positionType": posType,
		"price":        fmt.Sprintf("%.4f", req.TakeProfit*1.001),
		"triggerPrice": fmt.Sprintf("%.4f", req.TakeProfit),
		"vol":          size,
		"reduceOnly":   true,
	}
	if _, err := e.signedPost(ctx, "/api/v1/private/order/create", tpBody); err != nil {
		log.Printf("[MEXC] TP order failed: %v", err)
	} else {
		log.Printf("[MEXC] TP order placed @ %.4f", req.TakeProfit)
	}

	log.Printf("[MEXC] ✓ Complete %s %s size=%.4f", req.Side, req.Symbol, size)
	return nil
}

func (e *Executor) setLeverage(ctx context.Context, symbol string, posType, leverage int) error {
	body := map[string]interface{}{
		"symbol":       symbol,
		"positionType": posType,
		"lever":        leverage,
		"openType":     1,
	}
	resp, err := e.signedPost(ctx, "/api/v1/private/position/change_leverage", body)
	if err != nil { return err }
	var r struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(resp, &r)
	if !r.Success { return fmt.Errorf("mexc leverage: %s", r.Message) }
	return nil
}

func (e *Executor) fetchBalance(ctx context.Context) (float64, error) {
	resp, err := e.signedGet(ctx, "/api/v1/private/account/assets", "")
	if err != nil { return 0, err }
	var result struct {
		Success bool `json:"success"`
		Data    []struct {
			Currency  string `json:"currency"`
			Available string `json:"availableBalance"`
		} `json:"data"`
	}
	if err := json.Unmarshal(resp, &result); err != nil { return 0, err }
	for _, a := range result.Data {
		if a.Currency == "USDT" {
			v, _ := strconv.ParseFloat(a.Available, 64)
			return v, nil
		}
	}
	return 0, fmt.Errorf("USDT not found")
}

func (e *Executor) FetchFreeUSDT(ctx context.Context) (float64, error) {
	return e.fetchBalance(ctx)
}

// ── Signing ───────────────────────────────────────────────────────────────────

func (e *Executor) signedPost(ctx context.Context, path string, body map[string]interface{}) ([]byte, error) {
	payload, _ := json.Marshal(body)
	ts  := strconv.FormatInt(time.Now().UnixMilli(), 10)
	raw := e.cfg.APIKey + ts + string(payload)
	sign := signHMAC(raw, e.cfg.APISecret)

	req, _ := http.NewRequestWithContext(ctx, "POST", mexcBase+path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("ApiKey", e.cfg.APIKey)
	req.Header.Set("Request-Time", ts)
	req.Header.Set("Signature", sign)

	resp, err := e.client.Do(req)
	if err != nil { return nil, err }
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (e *Executor) signedGet(ctx context.Context, path, queryStr string) ([]byte, error) {
	ts   := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sign := signHMAC(e.cfg.APIKey+ts+queryStr, e.cfg.APISecret)

	url := mexcBase + path
	if queryStr != "" { url += "?" + queryStr }
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("ApiKey", e.cfg.APIKey)
	req.Header.Set("Request-Time", ts)
	req.Header.Set("Signature", sign)

	resp, err := e.client.Do(req)
	if err != nil { return nil, err }
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func signHMAC(data, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}
