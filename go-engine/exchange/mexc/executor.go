// go-engine/exchange/mexc/executor.go
//
// MEXC Futures Executor
// =====================
// BUG FIX (v3.0.1): Renamed public Execute(ctx, OrderRequest) → execute(ctx, OrderRequest)
// so adapter.go can define the single public Execute(ctx, interface{}) that satisfies
// main.go's orderExec interface without a duplicate-method compile error.
//
// BUG FIX (v3.1.0): [FIX-MEXC-BAL]
//   ROOT CAUSE: fetchBalance mengembalikan "USDT balance not found in response"
//   karena response MEXC Futures API /api/v1/private/account/assets kadang
//   return field name berbeda, atau `success` = false tanpa error jelas.
//   FIX:
//   1. Log raw response agar bisa debug API issue langsung dari bot.log
//   2. Parse multi-field fallback: availableBalance → cashBalance → equity
//   3. Case-insensitive currency match (USDT / usdt)
//   4. Cek success + code field, log error message dari API
//   5. Jika semua field 0 tapi ada data, return 0 dengan info (bukan error)
//      agar bot tahu balance = 0 bukan error koneksi
//
// MEXC uses Hedge Mode (two-sided position) and requires separate
// TP/SL orders submitted AFTER the entry order fills.
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
	"strings"
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

// execute is the internal typed entry point (lowercase — called by adapter.go).
func (e *Executor) execute(ctx context.Context, req OrderRequest) error {
	log.Printf("[MEXC] ── %s %s ────────────────────────", req.Side, req.Symbol)
	log.Printf("[MEXC] entry=%.4f TP=%.4f SL=%.4f RR=%.2f", req.Entry, req.TakeProfit, req.StopLoss, req.RiskReward)

	if e.cfg.DryRun {
		log.Printf("[MEXC] DRY RUN — skipped")
		return nil
	}

	freeUSDT, err := e.fetchBalance(ctx)
	if err != nil {
		return fmt.Errorf("balance: %w", err)
	}
	if freeUSDT < 1.0 {
		return fmt.Errorf("balance insufficient: %.2f USDT (min $1)", freeUSDT)
	}

	stopDist := math.Abs(req.Entry - req.StopLoss)
	if stopDist < 1e-8 {
		return fmt.Errorf("degenerate SL")
	}
	riskUSDT := freeUSDT * e.cfg.RiskPct
	rawSize  := riskUSDT / stopDist
	size     := math.Round(rawSize*1000) / 1000 // 3dp

	isLong  := req.Side == "BUY"
	posType := 1
	if !isLong {
		posType = 2
	}
	exitSide := "SELL"
	if !isLong {
		exitSide = "BUY"
	}

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
	if err != nil {
		return fmt.Errorf("entry order: %w", err)
	}
	var entryResult struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
		Data    string `json:"data"` // orderId
	}
	if err := json.Unmarshal(entryResp, &entryResult); err != nil {
		return err
	}
	if !entryResult.Success {
		return fmt.Errorf("MEXC entry: %s", entryResult.Message)
	}
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
	if err != nil {
		return err
	}
	var r struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(resp, &r)
	if !r.Success {
		return fmt.Errorf("mexc leverage: %s", r.Message)
	}
	return nil
}

// fetchBalance fetches available USDT balance from MEXC Futures.
//
// [FIX-MEXC-BAL] Rewritten to be robust:
//   - Logs raw response for every call (visible in bot.log)
//   - Multi-field fallback: availableBalance → cashBalance → equity
//   - Case-insensitive currency match
//   - Proper error message from API (success=false, code, message)
//   - Handles both string and number JSON types for balance fields
func (e *Executor) fetchBalance(ctx context.Context) (float64, error) {
	resp, err := e.signedGet(ctx, "/api/v1/private/account/assets", "")
	if err != nil {
		return 0, fmt.Errorf("HTTP request: %w", err)
	}

	// [FIX-MEXC-BAL] Always log raw response — critical for diagnosing API issues
	log.Printf("[MEXC-BAL] raw response: %s", truncateLog(string(resp), 400))

	// Parse loosely — MEXC sometimes returns numbers, sometimes strings
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(resp, &raw); err != nil {
		return 0, fmt.Errorf("JSON parse error: %w (body: %s)", err, truncateLog(string(resp), 200))
	}

	// Check success field
	if successRaw, ok := raw["success"]; ok {
		var success bool
		if err := json.Unmarshal(successRaw, &success); err == nil && !success {
			// Extract error message
			apiMsg := ""
			if msgRaw, ok := raw["message"]; ok {
				_ = json.Unmarshal(msgRaw, &apiMsg)
			}
			apiCode := 0
			if codeRaw, ok := raw["code"]; ok {
				_ = json.Unmarshal(codeRaw, &apiCode)
			}
			return 0, fmt.Errorf("MEXC API error code=%d msg=%q (check API key/permissions)", apiCode, apiMsg)
		}
	}

	// Parse data array
	dataRaw, ok := raw["data"]
	if !ok {
		return 0, fmt.Errorf("no 'data' field in response: %s", truncateLog(string(resp), 200))
	}

	var assets []map[string]json.RawMessage
	if err := json.Unmarshal(dataRaw, &assets); err != nil {
		return 0, fmt.Errorf("data parse error: %w", err)
	}

	if len(assets) == 0 {
		return 0, fmt.Errorf("empty asset list — account may have no MEXC Futures balance")
	}

	// [FIX-MEXC-BAL] Multi-field fallback loop
	for _, asset := range assets {
		// Get currency name — case-insensitive match
		currencyRaw, ok := asset["currency"]
		if !ok {
			continue
		}
		var currency string
		_ = json.Unmarshal(currencyRaw, &currency)
		if strings.ToUpper(currency) != "USDT" {
			continue
		}

		// Try fields in priority order
		for _, fieldName := range []string{"availableBalance", "available", "cashBalance", "equity", "walletBalance"} {
			fieldRaw, ok := asset[fieldName]
			if !ok {
				continue
			}
			v := parseJSONNumber(fieldRaw)
			if v > 0 {
				log.Printf("[MEXC-BAL] USDT balance from field '%s': %.4f", fieldName, v)
				return v, nil
			}
		}

		// Found USDT but all balances are 0 — not an error, just empty account
		log.Printf("[MEXC-BAL] USDT found but all balance fields = 0 (empty account?)")
		return 0, fmt.Errorf("USDT balance = 0 (deposit funds or check account type)")
	}

	return 0, fmt.Errorf("USDT not found in %d assets — wrong account type? (need Futures account)", len(assets))
}

// parseJSONNumber parses a JSON value that might be a string "123.45" or number 123.45
func parseJSONNumber(raw json.RawMessage) float64 {
	// Try as float64 first (JSON number)
	var f float64
	if err := json.Unmarshal(raw, &f); err == nil {
		return f
	}
	// Try as string
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		f, _ = strconv.ParseFloat(strings.TrimSpace(s), 64)
		return f
	}
	return 0
}

func truncateLog(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
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
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (e *Executor) signedGet(ctx context.Context, path, queryStr string) ([]byte, error) {
	ts   := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sign := signHMAC(e.cfg.APIKey+ts+queryStr, e.cfg.APISecret)

	url := mexcBase + path
	if queryStr != "" {
		url += "?" + queryStr
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("ApiKey", e.cfg.APIKey)
	req.Header.Set("Request-Time", ts)
	req.Header.Set("Signature", sign)

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func signHMAC(data, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}
