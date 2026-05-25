// go-engine/main.go
//
// TradeBot Go Orchestrator
// ========================
// Lifecycle:
//   1. Parse .env / env vars
//   2. Open (or create) POSIX SHM segment → Go owns creation
//   3. Start HTTP gateway (dashboard server, port 8765)
//   4. Start market Feed (WebSocket price + REST OHLCV/OI/LSR)
//   5. Start RSS/sentiment goroutine → writes sentiment into SHM via Feed
//   6. Loop: poll SHM for Rust signal → evaluate → execute order
//   7. Graceful shutdown on SIGINT/SIGTERM
//
// Design constraints:
//   - This file is intentionally thin. All business logic lives in sub-packages.
//   - SHM segment MUST be created here (before Rust starts) because Rust only opens,
//     never creates (see rust-brain/src/shm.rs → ShmBridge::open).
//   - Order execution is fire-and-forget in a goroutine so signal polling never blocks.

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"tradebot/go-engine/exchange/bybit"
	"tradebot/go-engine/exchange/mexc"
	"tradebot/go-engine/gateway"
	"tradebot/go-engine/market"
	"tradebot/go-engine/shm"
)

// ── Config ────────────────────────────────────────────────────────────────────

type Config struct {
	Exchange     string  // "bybit" | "mexc"
	ExchangeMode string  // "demo" | "real"
	Symbol       string  // e.g. "SOLUSDT"
	OHLCVTF      string  // timeframe: "5" (minutes, Bybit format)
	OHLCVLimit   int     // candle count for feed
	RiskPct      float64 // fraction of balance to risk (0.03 = 3%)
	Leverage     int
	DryRun       bool

	BybitAPIKey     string
	BybitAPISecret  string
	BybitDemoKey    string
	BybitDemoSecret string
	MexcAPIKey      string
	MexcAPISecret   string

	BaseDir string
}

func loadConfig() Config {
	loadEnvFile(".env")

	c := Config{
		Exchange:     envStr("EXCHANGE", "bybit"),
		ExchangeMode: envStr("EXCHANGE_MODE", "demo"),
		Symbol:       envStr("SYMBOL", "SOLUSDT"),
		OHLCVTF:      "5",
		OHLCVLimit:   200,
		RiskPct:      envFloat("RISK_PCT", 0.03),
		Leverage:     envInt("LEVERAGE", 10),
		DryRun:       envBool("DRY_RUN", true),

		BybitAPIKey:     envStr("BYBIT_API_KEY", envStr("BYBIT_REAL_API_KEY", "")),
		BybitAPISecret:  envStr("BYBIT_API_SECRET", envStr("BYBIT_REAL_API_SECRET", "")),
		BybitDemoKey:    envStr("BYBIT_DEMO_API_KEY", ""),
		BybitDemoSecret: envStr("BYBIT_DEMO_API_SECRET", ""),
		MexcAPIKey:      envStr("MEXC_API_KEY", ""),
		MexcAPISecret:   envStr("MEXC_API_SECRET", ""),
	}
	c.BaseDir = filepath.Dir(execPath())
	return c
}

// ── Main ─────────────────────────────────────────────────────────────────────

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	log.Printf("═══════════════════════════════════════════")
	log.Printf("  TradeBot Go Orchestrator  v3.0")
	log.Printf("═══════════════════════════════════════════")

	cfg := loadConfig()
	log.Printf("[main] exchange=%s mode=%s symbol=%s dryRun=%v",
		cfg.Exchange, cfg.ExchangeMode, cfg.Symbol, cfg.DryRun)

	// ── 1. Open SHM (Go MUST create it before Rust starts) ───────────────────
	bridge, err := shm.Open()
	if err != nil {
		log.Fatalf("[main] SHM open failed: %v", err)
	}
	defer bridge.Close()
	log.Printf("[main] SHM /tradebot_v3 ready")

	// ── 2. Create executor (Bybit or MEXC) ───────────────────────────────────
	var orderExecutor orderExec
	switch strings.ToLower(cfg.Exchange) {
	case "bybit":
		apiKey, apiSecret := cfg.BybitAPIKey, cfg.BybitAPISecret
		testnet := strings.ToLower(cfg.ExchangeMode) == "demo"
		if testnet {
			apiKey, apiSecret = cfg.BybitDemoKey, cfg.BybitDemoSecret
		}
		orderExecutor = bybit.New(bybit.Config{
			APIKey:    apiKey,
			APISecret: apiSecret,
			Testnet:   testnet,
			DryRun:    cfg.DryRun,
			Leverage:  cfg.Leverage,
			RiskPct:   cfg.RiskPct,
		})
	case "mexc":
		orderExecutor = mexc.New(mexc.Config{
			APIKey:    cfg.MexcAPIKey,
			APISecret: cfg.MexcAPISecret,
			DryRun:    cfg.DryRun,
			Leverage:  cfg.Leverage,
			RiskPct:   cfg.RiskPct,
		})
	default:
		log.Fatalf("[main] Unknown exchange: %s", cfg.Exchange)
	}

	// ── 3. Fetch initial balance for dashboard ────────────────────────────────
	ctx := context.Background()
	balance := 0.0
	if !cfg.DryRun {
		if b, err := fetchBalance(ctx, orderExecutor); err == nil {
			balance = b
			log.Printf("[main] Balance: %.2f USDT", balance)
		} else {
			log.Printf("[main] Balance fetch warning: %v", err)
		}
	} else {
		balance = 10_000.0
		log.Printf("[main] DRY RUN — simulated balance %.2f USDT", balance)
	}

	// ── 4. Start Gateway (dashboard HTTP server) ──────────────────────────────
	srv := gateway.New(cfg.BaseDir)
	go srv.Start()
	log.Printf("[main] Dashboard: http://localhost:%d", gateway.Port)

	// ── 5. Start market Feed ──────────────────────────────────────────────────
	feed := market.New(bridge, cfg.Symbol, cfg.OHLCVTF, cfg.OHLCVLimit)

	mainCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go feed.Run(mainCtx)

	// ── 6. Signal poll loop ───────────────────────────────────────────────────
	lastRustSeq := uint64(0)
	lastAction := "WAIT"
	cooldownUntil := time.Time{}
	consecutiveLosses := 0

	go func() {
		log.Printf("[main] Signal poll loop started")
		for {
			select {
			case <-mainCtx.Done():
				return
			default:
			}

			sig := bridge.PollSignal(200 * time.Millisecond)
			if sig == nil {
				continue
			}

			// Deduplicate: skip if same frame
			if sig.TsMs == int64(lastRustSeq) {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			lastRustSeq = uint64(sig.TsMs)

			dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]
			log.Printf("[main] Signal: %s conf=%.3f entry=%.4f TP=%.4f SL=%.4f RR=%.2f veto=%v",
				dirStr, sig.Confidence, sig.Entry, sig.TakeProfit, sig.StopLoss,
				sig.RiskReward, sig.Veto)

			// Update balance periodically
			if !cfg.DryRun && dirStr != "WAIT" {
				if b, err := fetchBalance(context.Background(), orderExecutor); err == nil {
					balance = b
				}
			}

			// Update insight file for dashboard
			updateInsight(srv, cfg, sig, balance, dirStr, feed)

			// Circuit breaker: don't trade if veto or cooldown
			if sig.Veto || dirStr == "WAIT" {
				lastAction = "WAIT"
				continue
			}

			if time.Now().Before(cooldownUntil) {
				log.Printf("[main] In cooldown until %s — skipping signal", cooldownUntil.Format("15:04:05"))
				continue
			}

			// Prevent same-direction double entry
			if dirStr == lastAction {
				log.Printf("[main] Duplicate signal direction=%s — skipping", dirStr)
				continue
			}

			// Sanity check on RR
			if sig.RiskReward < 1.2 {
				log.Printf("[main] RR %.2f < 1.2 — skipping low-quality signal", sig.RiskReward)
				continue
			}

			lastAction = dirStr

			// Fire order in goroutine (non-blocking)
			snapSig := *sig
			snapDir := dirStr
			go func() {
				req := buildOrderRequest(snapSig, snapDir, cfg.Symbol)
				execCtx, execCancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer execCancel()

				if err := orderExecutor.Execute(execCtx, req); err != nil {
					log.Printf("[main] Order execution failed: %v", err)
					consecutiveLosses++
					if consecutiveLosses >= 3 {
						cooldownUntil = time.Now().Add(60 * time.Minute)
						consecutiveLosses = 0
						log.Printf("[main] CIRCUIT BREAKER: 3 consecutive failures, 60-min cooldown")
					}
				} else {
					log.Printf("[main] ✓ Order fired: %s %s", snapDir, cfg.Symbol)
					consecutiveLosses = 0
				}
			}()
		}
	}()

	// ── 7. Graceful shutdown ──────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Printf("[main] Shutdown signal received — closing...")
	cancel()
	srv.Stop()
	time.Sleep(500 * time.Millisecond)
	log.Printf("[main] Clean shutdown complete")
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// orderExec is the common interface between Bybit and MEXC executors.
// Both implement Execute(ctx, req) and FetchFreeUSDT(ctx).
type orderExec interface {
	Execute(ctx context.Context, req interface{}) error
	FetchFreeUSDT(ctx context.Context) (float64, error)
}

func buildOrderRequest(sig shm.Signal, dir string, symbol string) interface{} {
	// The two executor packages use identically shaped structs — we build
	// the correct one at the call site, but for now we pass a neutral map
	// and let each executor's Execute() handle its own type assertion.
	return map[string]interface{}{
		"Symbol":     symbol,
		"Side":       dir,
		"Entry":      sig.Entry,
		"TakeProfit": sig.TakeProfit,
		"StopLoss":   sig.StopLoss,
		"RiskReward": sig.RiskReward,
		"Confidence": sig.Confidence,
	}
}

func fetchBalance(ctx context.Context, exec orderExec) (float64, error) {
	return exec.FetchFreeUSDT(ctx)
}

func updateInsight(srv *gateway.Server, cfg Config, sig *shm.Signal, balance float64, action string, feed *market.Feed) {
	state := feed.State()
	lsr := state.LSR
	if lsr < 1e-9 {
		lsr = 1.0
	}

	bias := "NEUTRAL"
	if lsr > 1.05 {
		bias = "LONG_HEAVY"
	} else if lsr < 0.95 {
		bias = "SHORT_HEAVY"
	}

	trend := "RANGING"
	if lsr > 1.05 {
		trend = "BULLISH"
	} else if lsr < 0.95 {
		trend = "BEARISH"
	}
	if sig.Veto {
		trend = "VETO — " + truncate(sig.VetoReason, 40)
	}

	advice := fmt.Sprintf("Consensus: WAIT (conf=%.3f)", sig.Confidence)
	if action != "WAIT" {
		advice = fmt.Sprintf("Signal %s! entry=%.4f TP=%.4f SL=%.4f RR=%.2f",
			action, sig.Entry, sig.TakeProfit, sig.StopLoss, sig.RiskReward)
	}

	// 24h price change: approximate from ATR vs price
	pct24h := 0.0
	if state.Price > 0 && state.ATR14 > 0 {
		pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10
	}

	srv.UpdateInsight(gateway.InsightData{
		Symbol:       cfg.Symbol,
		LastPrice:    state.Price,
		OpenInterest: state.OI,
		LSRVal:       lsr,
		Pct24h:       pct24h,
		TrendState:   trend,
		WhaleBias:    bias,
		SignalStatus: action,
		Advice:       advice,
		Timestamp:    time.Now().Format("15:04:05"),
		Balance:      balance,
		EntryTarget:  sig.Entry,
		TPTarget:     sig.TakeProfit,
		SLTarget:     sig.StopLoss,
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ── Env helpers ───────────────────────────────────────────────────────────────

func loadEnvFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		k := strings.TrimSpace(parts[0])
		v := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
		if os.Getenv(k) == "" {
			os.Setenv(k, v)
		}
	}
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil {
			return i
		}
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		return v == "1" || strings.ToLower(v) == "true"
	}
	return def
}

func execPath() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	return p
}

// JSON marshal helper for debug logging
func toJSON(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}
