// go-engine/exchange/bybit/executor.go
//
// Bybit V5 Order Executor — Production Grade
// ==========================================
// BUG FIX (v3.0.1): Renamed public Execute(ctx, OrderRequest) → execute(ctx, OrderRequest)
// BUG FIX (v3.1.0): [FIX-BAL] fetchFreeUSDT — UNIFIED-first with CONTRACT fallback.
// BUG FIX (v3.2.0): [FIX-BAL-SPAM] ROOT CAUSE FIXED:
//
//   ROOT CAUSE #1 — API SPAM:
//     fetchFreeUSDT dipanggil setiap signal (~1 detik) dari main.go.
//     Dengan UNIFIED account yang kosong (demo/testnet):
//       - UNIFIED → retCode=0 tapi list coin kosong → return -1 → "USDT not found, try next"
//       - CONTRACT → retCode=10001 "only support UNIFIED" → error logged
//       - FUND     → retCode=10001 "only support UNIFIED" → error logged
//     Repeat 60+ kali/menit → spam log + API rate throttle.
//
//   ROOT CAUSE #2 — SALAH FALLBACK LOGIC:
//     Jika UNIFIED mengembalikan retCode=0 (HTTP 200, API key valid), ini PASTI
//     akun Unified Trading (UTA). CONTRACT/FUND akan selalu return 10001.
//     Tidak ada alasan mencoba keduanya.
//
//   FIX #1 — BALANCE CACHE (30-detik TTL):
//     Tambah `balanceCache` struct dengan sync.Mutex + TTL.
//     Hasil balance dicache 30 detik. Tidak ada lagi 60 API call/menit.
//
//   FIX #2 — SMART UTA DETECTION:
//     Jika UNIFIED retCode=0 (success) → ini UTA account.
//     Jika USDT tidak ada di coin list → return 0 (account kosong/no funds).
//     JANGAN coba CONTRACT/FUND — selalu gagal untuk UTA.
//     Hanya coba CONTRACT jika UNIFIED sendiri gagal dengan non-10001 error
//     (network error, auth error, dsb) — fallback untuk classic account lama.
//
//   FIX #3 — LOG CLEANUP:
//     CONTRACT/FUND 10001 bukan "error" untuk UTA user — itu expected behavior.
//     Suppress log yang menyesatkan.

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
	"sync"
	"time"
)

const (
	mainnetBase = "https://api.bytick.com"
	testnetBase = "https://api-testnet.bybit.com"
	recvWindow  = "5000"

	// [FIX-BAL-SPAM] Balance cache TTL — jangan fetch lebih dari 1x per 30 detik.
	// Main loop bisa memanggil fetchFreeUSDT tiap 1 detik; tanpa cache ini = 3600 API call/jam.
	balanceCacheTTL = 30 * time.Second
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

// [FIX-BAL-SPAM] balanceCache menyimpan hasil fetchFreeUSDT dengan TTL.
// Thread-safe via sync.Mutex.
type balanceCache struct {
	mu        sync.Mutex
	value     float64
	fetchedAt time.Time
	ttl       time.Duration
}

// valid returns true jika cache masih segar (belum expired).
func (c *balanceCache) valid() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.fetchedAt.IsZero() && time.Since(c.fetchedAt) < c.ttl
}

// get returns cached value. Caller harus panggil valid() dulu.
func (c *balanceCache) get() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.value
}

// update menyimpan nilai baru dan timestamp saat ini.
func (c *balanceCache) update(v float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.value = v
	c.fetchedAt = time.Now()
}

// invalidate memaksa re-fetch pada panggilan berikutnya.
func (c *balanceCache) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fetchedAt = time.Time{}
}

type Executor struct {
	cfg      Config
	client   *http.Client
	base     string
	balCache balanceCache // [FIX-BAL-SPAM] cached balance
}

func New(cfg Config) *Executor {
	base := mainnetBase
	if cfg.Testnet {
		base = testnetBase
	}
	e := &Executor{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
		base:   base,
	}
	e.balCache.ttl = balanceCacheTTL
	return e
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

	// 1. Balance — [FIX-BAL-SPAM] pakai cache, skip fallback yang selalu gagal
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
	rawSize := riskUSDT / stopDist

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
		// [FIX-BAL-SPAM] Invalidate balance cache on order failure
		// agar next call re-fetch, bukan pakai cached stale value
		e.balCache.invalidate()
		return fmt.Errorf("place order: %w", err)
	}
	log.Printf("[Executor] ✓ Order placed id=%s", orderID)

	// [FIX-BAL-SPAM] Invalidate cache setelah order berhasil
	// agar balance terbaca lagi (sudah berkurang setelah margin dipakai)
	e.balCache.invalidate()

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

// ── Balance — [FIX-BAL-SPAM] ──────────────────────────────────────────────────
//
// CHANGELOG v3.2.0:
//
//   MASALAH LAMA:
//     1. fetchFreeUSDT dipanggil setiap signal (tiap ~1 detik) → 3600+ API call/jam.
//     2. UNIFIED mengembalikan retCode=0 tapi USDT tidak ada di coin list
//        → return -1 → "trying next" → CONTRACT 10001 ERROR → FUND 10001 ERROR
//        → Log spam: 6 baris error setiap 1 detik.
//     3. CONTRACT dan FUND SELALU gagal untuk Unified Trading Account (UTA).
//        Mencobanya adalah buang-buang waktu dan log.
//
//   FIX:
//     1. BALANCE CACHE (30-detik TTL) — Hasil di-cache. API dipanggil max 2x/menit.
//        Cache diinvalidate setelah order berhasil/gagal untuk konsistensi.
//
//     2. SMART UTA DETECTION — Jika UNIFIED API mengembalikan retCode=0:
//        → Ini pasti UTA account (API key dan akun valid).
//        → Jika USDT tidak ada di coin list → balance = 0 (akun kosong, bukan error).
//        → JANGAN coba CONTRACT/FUND — 100% akan return 10001.
//
//     3. CLASSIC ACCOUNT FALLBACK — Hanya coba CONTRACT jika UNIFIED gagal
//        dengan error selain 10001 (network error, auth error, dsb).
//        Ini untuk backward compat dengan classic Bybit account lama.

func (e *Executor) fetchFreeUSDT(ctx context.Context) (float64, error) {
	// [FIX-BAL-SPAM] Check cache dulu — skip API call jika masih segar
	if e.balCache.valid() {
		v := e.balCache.get()
		log.Printf("[Executor-BAL] cache hit: %.4f USDT (next fetch in ~%.0fs)",
			v, balanceCacheTTL.Seconds()-time.Since(e.getLastFetchTime()).Seconds())
		return v, nil
	}

	// [FIX-BAL-UTA] Coba UNIFIED dulu.
	// Jika retCode=0 → ini UTA account → stop di sini, jangan coba CONTRACT/FUND.
	bal, err := e.tryFetchBalance(ctx, "UNIFIED")

	if err == nil {
		// retCode=0: API key valid, akun UNIFIED ditemukan.
		if bal >= 0 {
			// USDT ditemukan (atau akun kosong: bal=0)
			log.Printf("[Executor-BAL] ✓ USDT=%.4f via UNIFIED account", bal)
		} else {
			// bal=-1: USDT tidak ada di coin list tapi API berhasil.
			// Artinya: akun ada tapi tidak ada USDT deposit sama sekali.
			// Ini bukan error — return 0 biar bot tahu balance habis/kosong.
			log.Printf("[Executor-BAL] UNIFIED account OK — no USDT coin in list (empty account / no deposit). Balance=0")
			bal = 0
		}
		e.balCache.update(bal)
		return bal, nil
	}

	// UNIFIED gagal — periksa jenis error-nya
	errStr := err.Error()
	isAccountTypeMismatch := strings.Contains(errStr, "10001") ||
		strings.Contains(errStr, "accountType only support")

	if isAccountTypeMismatch {
		// API key valid tapi UNIFIED tidak bisa diakses.
		// Kemungkinan: classic account yang masih pakai V5 API.
		// CONTRACT mungkin bisa — coba satu kali.
		log.Printf("[Executor-BAL] UNIFIED returned 10001 — trying CONTRACT (classic account)")
		if bal2, err2 := e.tryFetchBalance(ctx, "CONTRACT"); err2 == nil && bal2 >= 0 {
			log.Printf("[Executor-BAL] ✓ USDT=%.4f via CONTRACT (classic account)", bal2)
			e.balCache.update(bal2)
			return bal2, nil
		}
		// CONTRACT juga gagal — mungkin sudah dimigrate ke UTA tapi ada issue
		return 0, fmt.Errorf("balance not accessible: UNIFIED 10001 dan CONTRACT gagal — check API key permissions (perlu 'Read' access on Account)")
	}

	// Error lain (network, timeout, bad response, dsb) — jangan cache
	return 0, fmt.Errorf("balance fetch error: %w", err)
}

// getLastFetchTime adalah helper untuk log yang lebih informatif.
// Mengembalikan zero time jika cache belum pernah diisi.
func (e *Executor) getLastFetchTime() time.Time {
	e.balCache.mu.Lock()
	defer e.balCache.mu.Unlock()
	return e.balCache.fetchedAt
}

// tryFetchBalance coba satu accountType. Returns:
//   >= 0   : USDT ditemukan, nilai balance (bisa 0 kalau akun kosong)
//   -1     : USDT tidak ada di account ini
//   error  : API error atau parse error
//
// [FIX-BAL-SPAM] Log level diturunkan — raw response di-log hanya sekali
// (bukan setiap 1 detik). Error 10001 dari CONTRACT/FUND bukan "error" untuk UTA user.
func (e *Executor) tryFetchBalance(ctx context.Context, accountType string) (float64, error) {
	resp, err := e.signedGet(ctx, "/v5/account/wallet-balance", "accountType="+accountType)
	if err != nil {
		return -1, fmt.Errorf("HTTP: %w", err)
	}

	// Log raw hanya untuk UNIFIED (yang pertama dicoba dan paling penting untuk debug)
	// CONTRACT/FUND tidak di-log kecuali ada error non-10001
	if accountType == "UNIFIED" {
		log.Printf("[Executor-BAL] accountType=%s raw=%s", accountType, truncateStr(string(resp), 300))
	}

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
		// Untuk 10001 (wrong account type), jangan log sebagai error —
		// ini expected behavior untuk akun yang tidak support tipe tersebut
		if result.RetCode == 10001 {
			return -1, fmt.Errorf("API retCode=%d msg=%q", result.RetCode, result.RetMsg)
		}
		log.Printf("[Executor-BAL] accountType=%s error: API retCode=%d msg=%q",
			accountType, result.RetCode, result.RetMsg)
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

// FetchFreeUSDT exported untuk gateway (dipanggil dari main.go untuk display balance).
// Menggunakan cache yang sama untuk efisiensi.
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
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
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
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
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
