// go-engine/exchange/bybit/executor.go
//
// Bybit V5 Order Executor — Production Grade
// ==========================================
// BUG FIX (v3.0.1): Renamed public Execute(ctx, OrderRequest) → execute(ctx, OrderRequest)
// BUG FIX (v3.1.0): [FIX-BAL] fetchFreeUSDT sekarang coba UNIFIED dulu, fallback CONTRACT.
//   ROOT CAUSE: Bybit Unified Trading Account (UTA) pakai accountType=UNIFIED.
//   Code lama hardcode accountType=CONTRACT → response sukses tapi list coin kosong
//   → "USDT balance not found in response" → semua order gagal.
//   FIX:
//   1. Loop UNIFIED → CONTRACT → FUND, stop di yang pertama return USDT > 0
//   2. Log raw response (truncated) supaya gampang debug kalau masih gagal
//   3. Multi-field fallback: availableToWithdraw → walletBalance → equity
//   4. Return 0 (bukan error) kalau USDT ditemukan tapi balance = 0
//      supaya bot tau balance habis, bukan salah API key
//
// Layers of TP/SL defense:
//   Layer 1 : Embed takeProfit/stopLoss directly in the order params
//   Layer 2 : Post-fill verification via /v5/position/list
//   Layer 3 : Fallback via /v5/position/trading-stop if Layer 1 missed

package bybit

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
	mainnetBase = "https://api.bytick.com"
	testnetBase = "https://api-testnet.bybit.com"
	recvWindow  = "5000"
)

// Config holds credentials and behavioural flags
type Config struct {
	APIKey    string
	APISecret string
	Testnet   bool
	DryRun    bool
	Leverage  int
	RiskPct   float64
}

// OrderRequest is the structured input from ConsensusEngine → Executor
type OrderRequest struct {
	Symbol     string
	Side       string // "Buy" | "Sell"
	Entry      float64
	TakeProfit float64
	StopLoss   float64
	RiskReward float64
	Confidence float64
}

type Executor struct {
	cfg    Config
	client *http.Client
	base   string
}

func New(cfg Config) *Executor {
	base := mainnetBase
	if cfg.Testnet {
		base = testnetBase
	}
	return &Executor{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
		base:   base,
	}
}

// execute adalah internal entry point (lowercase — dipanggil adapter.go).
func (e *Executor) execute(ctx context.Context, req OrderRequest) error {
	log.Printf("[Executor] ── %s %s ────────────────────────────", req.Side, req.Symbol)
	log.Printf("[Executor] entry=%.4f SL=%.4f TP=%.4f RR=%.2f conf=%.3f",
		req.Entry, req.StopLoss, req.TakeProfit, req.RiskReward, req.Confidence)

	if e.cfg.DryRun {
		log.Printf("[Executor] DRY RUN — orders suppressed.")
		return nil
	}

	// 1. Balance — [FIX-BAL] coba beberapa account type
	freeUSDT, err := e.fetchFreeUSDT(ctx)
	if err != nil {
		return fmt.Errorf("balance fetch: %w", err)
	}
	if freeUSDT < 1 {
		return fmt.Errorf("insufficient balance: %.2f USDT (need >= $1)", freeUSDT)
	}
	log.Printf("[Executor] balance=%.2f USDT", freeUSDT)

	// 2. Position size (Fixed Fractional)
	stopDist := math.Abs(req.Entry - req.StopLoss)
	if stopDist < 1e-8 {
		return fmt.Errorf("degenerate signal: entry≈stopLoss")
	}
	riskUSDT := freeUSDT * e.cfg.RiskPct
	rawSize  := riskUSDT / stopDist

	notional := rawSize * req.Entry
	if notional < 5.0 {
		return fmt.Errorf("notional %.2f < $5 minimum", notional)
	}

	size := roundStep(rawSize, 0.001)
	log.Printf("[Executor] size=%.4f notional=%.2f USDT risk=%.2f USDT", size, notional, riskUSDT)

	// 3. Leverage
	if err := e.setLeverage(ctx, req.Symbol, e.cfg.Leverage); err != nil {
		log.Printf("[Executor] leverage warning (non-fatal): %v", err)
	}

	// 4. Place order (Layer 1: embed TP/SL)
	orderID, err := e.placeOrder(ctx, req, size)
	if err != nil {
		return fmt.Errorf("place order: %w", err)
	}
	log.Printf("[Executor] ✓ Order placed id=%s", orderID)

	// 5. Layer 2 & 3: verify TP/SL
	go func() {
		time.Sleep(3 * time.Second)
		e.verifyAndFallbackTPSL(context.Background(), req)
	}()

	return nil
}

// ── Order placement ───────────────────────────────────────────────────────────

func (e *Executor) placeOrder(ctx context.Context, req OrderRequest, size float64) (string, error) {
	body := map[string]interface{}{
		"category":    "linear",
		"symbol":      bybitSymbol(req.Symbol),
		"side":        req.Side,
		"orderType":   "Limit",
		"qty":         fmt.Sprintf("%.4f", size),
		"price":       fmt.Sprintf("%.4f", req.Entry),
		"timeInForce": "GTC",
		"positionIdx": 0,
		"takeProfit":  fmt.Sprintf("%.4f", req.TakeProfit),
		"stopLoss":    fmt.Sprintf("%.4f", req.StopLoss),
		"tpTriggerBy": "LastPrice",
		"slTriggerBy": "LastPrice",
		"tpslMode":    "Full",
	}

	resp, err := e.signedPost(ctx, "/v5/order/create", body)
	if err != nil {
		return "", err
	}

	var result struct {
		RetCode int    `json:"retCode"`
		RetMsg  string `json:"retMsg"`
		Result  struct {
			OrderID string `json:"orderId"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		return "", err
	}
	if result.RetCode != 0 {
		return "", fmt.Errorf("bybit API %d: %s", result.RetCode, result.RetMsg)
	}
	return result.Result.OrderID, nil
}

// ── Layer 2 / 3: TP/SL verification & fallback ───────────────────────────────

func (e *Executor) verifyAndFallbackTPSL(ctx context.Context, req OrderRequest) {
	sym := bybitSymbol(req.Symbol)
	params := fmt.Sprintf("category=linear&symbol=%s", sym)
	resp, err := e.signedGet(ctx, "/v5/position/list", params)
	if err != nil {
		log.Printf("[Executor] position verify failed: %v", err)
		return
	}

	var result struct {
		Result struct {
			List []struct {
				TakeProfit string `json:"takeProfit"`
				StopLoss   string `json:"stopLoss"`
				Size       string `json:"size"`
			} `json:"list"`
		} `json:"result"`
	}
	if err := json.Unmarshal(resp, &result); err != nil {
		log.Printf("[Executor] position parse failed: %v", err)
		return
	}

	for _, pos := range result.Result.List {
		sz, _ := strconv.ParseFloat(pos.Size, 64)
		if sz <= 0 {
			continue
		}

		tp, _ := strconv.ParseFloat(pos.TakeProfit, 64)
		sl, _ := strconv.ParseFloat(pos.StopLoss, 64)

		if tp > 0 && sl > 0 {
			log.Printf("[Executor] Layer 1 OK — TP=%.4f SL=%.4f verified on position", tp, sl)
			return
		}

		log.Printf("[Executor] Layer 1 MISS — setting TP/SL via trading-stop")
		fallbackBody := map[string]interface{}{
			"category":    "linear",
			"symbol":      sym,
			"takeProfit":  fmt.Sprintf("%.4f", req.TakeProfit),
			"stopLoss":    fmt.Sprintf("%.4f", req.StopLoss),
			"tpTriggerBy": "LastPrice",
			"slTriggerBy": "LastPrice",
			"tpslMode":    "Full",
			"positionIdx": 0,
		}
		fbResp, err := e.signedPost(ctx, "/v5/position/trading-stop", fallbackBody)
		if err != nil {
			log.Printf("[Executor] Layer 3 FAILED: %v", err)
			return
		}
		var fbResult struct {
			RetCode int    `json:"retCode"`
			RetMsg  string `json:"retMsg"`
		}
		_ = json.Unmarshal(fbResp, &fbResult)
		if fbResult.RetCode == 0 {
			log.Printf("[Executor] Layer 3 OK — TP/SL secured via trading-stop")
		} else {
			log.Printf("[Executor] Layer 3 WARN: %d %s", fbResult.RetCode, fbResult.RetMsg)
		}
		return
	}
	log.Printf("[Executor] Position not found yet (limit order unfilled?) — skipping TP/SL verify")
}

// ── Balance — [FIX-BAL] ───────────────────────────────────────────────────────
//
// Bybit punya 3 tipe account:
//   UNIFIED  → Unified Trading Account (UTA) — akun baru default sejak 2023
//   CONTRACT → Classic derivatives account — akun lama
//   FUND     → Funding account (jarang untuk trading)
//
// Masalah lama: hardcode CONTRACT → UTA user dapat list kosong → "not found".
// Fix: coba UNIFIED dulu, fallback ke CONTRACT, fallback ke FUND.
// Tiap attempt di-log dengan truncated raw response untuk debug.

func (e *Executor) fetchFreeUSDT(ctx context.Context) (float64, error) {
	accountTypes := []string{"UNIFIED", "CONTRACT", "FUND"}

	for _, acctType := range accountTypes {
		bal, err := e.tryFetchBalance(ctx, acctType)
		if err != nil {
			log.Printf("[Executor-BAL] accountType=%s error: %v", acctType, err)
			continue
		}
		if bal >= 0 {
			// bal=0 bisa berarti akun kosong — valid, return tanpa error
			log.Printf("[Executor-BAL] ✓ USDT=%.4f via accountType=%s", bal, acctType)
			return bal, nil
		}
		// bal=-1 berarti USDT tidak ada di akun ini, coba berikutnya
		log.Printf("[Executor-BAL] accountType=%s — USDT not in this account, trying next", acctType)
	}

	return 0, fmt.Errorf("USDT balance not found in UNIFIED/CONTRACT/FUND accounts — check API key permissions (needs 'Read' on Account)")
}

// tryFetchBalance coba satu accountType. Returns:
//   >= 0   : USDT ditemukan, nilai balance (bisa 0 kalau akun kosong)
//   -1     : USDT tidak ada di account ini, coba account lain
//   error  : API error atau parse error
func (e *Executor) tryFetchBalance(ctx context.Context, accountType string) (float64, error) {
	resp, err := e.signedGet(ctx, "/v5/account/wallet-balance", "accountType="+accountType)
	if err != nil {
		return -1, fmt.Errorf("HTTP: %w", err)
	}

	// [FIX-BAL] Log raw untuk debug — truncate supaya log gak banjir
	log.Printf("[Executor-BAL] accountType=%s raw=%s", accountType, truncateStr(string(resp), 300))

	var result struct {
		RetCode int    `json:"retCode"`
		RetMsg  string `json:"retMsg"`
		Result  struct {
			List []struct {
				AccountType string `json:"accountType"`
				Coin        []struct {
					Coin                string `json:"coin"`
					WalletBalance       string `json:"walletBalance"`
					AvailableToWithdraw string `json:"availableToWithdraw"`
					AvailableToBorrow   string `json:"availableToBorrow"`
					Equity              string `json:"equity"`
					Free                string `json:"free"`
				} `json:"coin"`
			} `json:"list"`
		} `json:"result"`
	}

	if err := json.Unmarshal(resp, &result); err != nil {
		return -1, fmt.Errorf("JSON parse: %w", err)
	}

	if result.RetCode != 0 {
		return -1, fmt.Errorf("API retCode=%d msg=%q", result.RetCode, result.RetMsg)
	}

	for _, acct := range result.Result.List {
		for _, coin := range acct.Coin {
			if strings.ToUpper(coin.Coin) != "USDT" {
				continue
			}
			// Multi-field fallback — tiap exchange/akun bisa beda field yang terisi
			for fieldName, rawVal := range map[string]string{
				"availableToWithdraw": coin.AvailableToWithdraw,
				"walletBalance":       coin.WalletBalance,
				"equity":              coin.Equity,
				"free":                coin.Free,
			} {
				if rawVal == "" {
					continue
				}
				v, err := strconv.ParseFloat(rawVal, 64)
				if err == nil && v > 0 {
					log.Printf("[Executor-BAL] field=%s val=%.4f", fieldName, v)
					return v, nil
				}
			}
			// USDT ditemukan tapi semua field 0 → akun ada tapi kosong
			log.Printf("[Executor-BAL] USDT found in %s but all balance fields = 0 (empty account?)", accountType)
			return 0, nil
		}
	}

	// Account type ini tidak punya USDT coin sama sekali
	return -1, nil
}

// FetchFreeUSDT exported untuk gateway
func (e *Executor) FetchFreeUSDT(ctx context.Context) (float64, error) {
	return e.fetchFreeUSDT(ctx)
}

// ── Leverage ──────────────────────────────────────────────────────────────────

func (e *Executor) setLeverage(ctx context.Context, symbol string, leverage int) error {
	body := map[string]interface{}{
		"category":     "linear",
		"symbol":       bybitSymbol(symbol),
		"buyLeverage":  strconv.Itoa(leverage),
		"sellLeverage": strconv.Itoa(leverage),
	}
	resp, err := e.signedPost(ctx, "/v5/position/set-leverage", body)
	if err != nil {
		return err
	}
	var r struct {
		RetCode int    `json:"retCode"`
		RetMsg  string `json:"retMsg"`
	}
	_ = json.Unmarshal(resp, &r)
	if r.RetCode != 0 && r.RetCode != 110043 {
		return fmt.Errorf("setLeverage %d: %s", r.RetCode, r.RetMsg)
	}
	log.Printf("[Executor] Leverage %dx set on %s", leverage, symbol)
	return nil
}

// ── Signing ───────────────────────────────────────────────────────────────────

func (e *Executor) signedPost(ctx context.Context, path string, body map[string]interface{}) ([]byte, error) {
	payload, _ := json.Marshal(body)
	ts   := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sign := e.sign(ts + e.cfg.APIKey + recvWindow + string(payload))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		e.base+path, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-BAPI-API-KEY", e.cfg.APIKey)
	req.Header.Set("X-BAPI-TIMESTAMP", ts)
	req.Header.Set("X-BAPI-SIGN", sign)
	req.Header.Set("X-BAPI-RECV-WINDOW", recvWindow)

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (e *Executor) signedGet(ctx context.Context, path, queryStr string) ([]byte, error) {
	ts   := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sign := e.sign(ts + e.cfg.APIKey + recvWindow + queryStr)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		e.base+path+"?"+queryStr, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-BAPI-API-KEY", e.cfg.APIKey)
	req.Header.Set("X-BAPI-TIMESTAMP", ts)
	req.Header.Set("X-BAPI-SIGN", sign)
	req.Header.Set("X-BAPI-RECV-WINDOW", recvWindow)

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (e *Executor) sign(data string) string {
	mac := hmac.New(sha256.New, []byte(e.cfg.APISecret))
	mac.Write([]byte(data))
	return hex.EncodeToString(mac.Sum(nil))
}

// ── Utils ─────────────────────────────────────────────────────────────────────

func bybitSymbol(s string) string {
	s = strings.ReplaceAll(s, "/", "")
	s = strings.ReplaceAll(s, ":", "")
	s = strings.ReplaceAll(s, "USDTUSDT", "USDT")
	return s
}

func roundStep(v, step float64) float64 {
	if step <= 0 {
		return v
	}
	return math.Round(v/step) * step
}

func truncateStr(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "…"
}
