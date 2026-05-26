// go-engine/main.go
// FIXES:
// [FIX-A] lastAction di-reset ke "WAIT" setelah paper trade closes
//         → sebelumnya setelah 1 trade BUY, semua BUY berikutnya di-skip selamanya
// [FIX-B] lastAction timeout 10 menit → allow re-entry arah sama jika market memang trending
// [FIX-C] Log lebih jelas saat sinyal di-skip supaya ga bingung "kok ga entry"
// [FIX-D] Bot auto-running saat startup (server.go New() harus default Store(true))
package main

import (
	"context"
	"math"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"log"
	"fmt"

	"tradebot/go-engine/exchange/bybit"
	"tradebot/go-engine/exchange/mexc"
	"tradebot/go-engine/gateway"
	"tradebot/go-engine/market"
	"tradebot/go-engine/nlp"
	"tradebot/go-engine/shm"
)

type Config struct {
	Exchange     string
	ExchangeMode string
	Symbol       string
	OHLCVTF      string
	OHLCVLimit   int
	RiskPct      float64
	Leverage     int
	DryRun       bool
	TradingStyle string

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
		TradingStyle: envStr("TRADING_STYLE", "scalping"),

		BybitAPIKey:     envStr("BYBIT_API_KEY", envStr("BYBIT_REAL_API_KEY", "")),
		BybitAPISecret:  envStr("BYBIT_API_SECRET", envStr("BYBIT_REAL_API_SECRET", "")),
		BybitDemoKey:    envStr("BYBIT_DEMO_API_KEY", ""),
		BybitDemoSecret: envStr("BYBIT_DEMO_API_SECRET", ""),
		MexcAPIKey:      envStr("MEXC_API_KEY", ""),
		MexcAPISecret:   envStr("MEXC_API_SECRET", ""),
	}

	if pwd, err := os.Getwd(); err == nil {
		c.BaseDir = pwd
	} else {
		c.BaseDir = filepath.Dir(execPath())
	}

	return c
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)
	log.Printf("═══════════════════════════════════════════")
	log.Printf("  TradeBot Go Orchestrator  v3.0")
	log.Printf("═══════════════════════════════════════════")

	cfg := loadConfig()
	log.Printf("[main] exchange=%s mode=%s symbol=%s style=%s dryRun=%v",
		cfg.Exchange, cfg.ExchangeMode, cfg.Symbol, cfg.TradingStyle, cfg.DryRun)

	bridge, err := shm.Open()
	if err != nil { log.Fatalf("[main] SHM open failed: %v", err) }
	defer bridge.Close()
	log.Printf("[main] SHM /tradebot_v3 ready")

	var orderExecutor orderExec
	switch strings.ToLower(cfg.Exchange) {
	case "bybit":
		apiKey, apiSecret := cfg.BybitAPIKey, cfg.BybitAPISecret
		testnet := strings.ToLower(cfg.ExchangeMode) == "demo"
		if testnet { apiKey, apiSecret = cfg.BybitDemoKey, cfg.BybitDemoSecret }
		orderExecutor = bybit.New(bybit.Config{
			APIKey: apiKey, APISecret: apiSecret, Testnet: testnet, DryRun: cfg.DryRun, Leverage: cfg.Leverage, RiskPct: cfg.RiskPct,
		})
	case "mexc":
		orderExecutor = mexc.New(mexc.Config{
			APIKey: cfg.MexcAPIKey, APISecret: cfg.MexcAPISecret, DryRun: cfg.DryRun, Leverage: cfg.Leverage, RiskPct: cfg.RiskPct,
		})
	default:
		log.Fatalf("[main] Unknown exchange: %s", cfg.Exchange)
	}

	ctx := context.Background()
	balance := 0.0
	if !cfg.DryRun {
		if b, err := fetchBalance(ctx, orderExecutor); err == nil {
			balance = b
			log.Printf("[main]   Exchange connected | exchange=%s mode=%s | free_USDT=%.2f",
				cfg.Exchange, cfg.ExchangeMode, balance)
		} else {
			log.Printf("[main] API Auth Error: %v", err)
		}
	} else {
		balance = 10000.0
		log.Printf("[main]   Exchange connected | exchange=%s mode=%s | free_USDT=%.2f",
			cfg.Exchange, cfg.ExchangeMode, balance)
	}

	srv := gateway.New(cfg.BaseDir)
	go srv.Start()

	feed := market.New(bridge, cfg.Symbol, cfg.OHLCVTF, cfg.OHLCVLimit)
	mainCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go feed.Run(mainCtx)

	nlpEngine := nlp.NewEngine(cfg.Symbol, 5*time.Minute)
	go nlpEngine.Run(mainCtx, feed)

	lastRustSeq  := uint64(0)
	lastAction   := "WAIT"
	lastActionAt := time.Now().Add(-10 * time.Minute) // [FIX-B] init so first signal always passes
	cooldownUntil := time.Time{}
	consecutiveLosses := 0

	// [FIX-B] lastAction timeout berdasarkan trading style
	lastActionTimeout := map[string]time.Duration{
		"scalping":   10 * time.Minute,
		"daytrading": 30 * time.Minute,
		"swing":      4 * time.Hour,
	}
	getLastActionTimeout := func() time.Duration {
		style := strings.ToLower(cfg.TradingStyle)
		if d, ok := lastActionTimeout[style]; ok {
			return d
		}
		return 10 * time.Minute
	}

	var activePaperTrade *gateway.Position
	var paperHistory []gateway.Position

	go func() {
		log.Printf("[main] Signal poll loop started")
		for {
			select {
			case <-mainCtx.Done(): return
			default: }

			sig := bridge.PollSignal(200 * time.Millisecond)
			if sig == nil { continue }
			if uint64(sig.TsMs) == lastRustSeq { time.Sleep(10 * time.Millisecond); continue }
			lastRustSeq = uint64(sig.TsMs)

			state := feed.State()

			// ── [1] PAPER TRADING: cek TP/SL live ──────────────────────────────────
			if cfg.DryRun && activePaperTrade != nil {
				isClosed := false

				// kalkulasi live PnL dengan leverage
				unrealizedPct := 0.0
				if activePaperTrade.Side == "BUY" {
					unrealizedPct = ((state.Price - activePaperTrade.EntryPrice) / activePaperTrade.EntryPrice) * 100.0
				} else if activePaperTrade.Side == "SELL" {
					unrealizedPct = ((activePaperTrade.EntryPrice - state.Price) / activePaperTrade.EntryPrice) * 100.0
				}
				activePaperTrade.PnL = unrealizedPct * float64(cfg.Leverage)

				if (activePaperTrade.Side == "BUY" && state.Price >= activePaperTrade.TakeProfit) ||
				   (activePaperTrade.Side == "SELL" && state.Price <= activePaperTrade.TakeProfit) {
					activePaperTrade.Status = "CLOSED_TP"
					isClosed = true
				} else if (activePaperTrade.Side == "BUY" && state.Price <= activePaperTrade.StopLoss) ||
				          (activePaperTrade.Side == "SELL" && state.Price >= activePaperTrade.StopLoss) {
					activePaperTrade.Status = "CLOSED_SL"
					isClosed = true
				}

				if isClosed {
					log.Printf("[Paper] Trade Closed: %s | Side=%s | PnL=%.2f%%",
						activePaperTrade.Status, activePaperTrade.Side, activePaperTrade.PnL)
					paperHistory = append([]gateway.Position{*activePaperTrade}, paperHistory...)
					if len(paperHistory) > 50 {
						paperHistory = paperHistory[:50]
					}
					activePaperTrade = nil

					// [FIX-A] CRITICAL: reset lastAction setelah trade close
					// Tanpa ini, setelah 1x BUY → lastAction="BUY" selamanya → semua BUY di-skip
					lastAction = "WAIT"
					lastActionAt = time.Now().Add(-getLastActionTimeout()) // allow immediate re-entry
					log.Printf("[main] lastAction reset → siap re-entry")
				}

				srv.UpdatePositions(activePaperTrade, paperHistory)
			}

			// ── [2] TENTUKAN ARAH ─────────────────────────────────────────────────
			dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]
			if !srv.IsBotRunning() { dirStr = "WAIT" }

			printEntry, printTP, printSL := sig.Entry, sig.TakeProfit, sig.StopLoss
			if sig.Veto || printEntry == 0 {
				printEntry, printTP, printSL = state.Price, state.Price, state.Price
			}

			log.Printf("[main] Signal: %s conf=%.3f entry=%.4f TP=%.4f SL=%.4f RR=%.2f veto=%v",
				dirStr, sig.Confidence, printEntry, printTP, printSL, sig.RiskReward, sig.Veto)

			if !cfg.DryRun && dirStr != "WAIT" {
				if b, err := fetchBalance(context.Background(), orderExecutor); err == nil { balance = b }
			}

			if !srv.IsBotRunning() {
				lsr := state.LSR
				if lsr < 1e-9 { lsr = 1.0 }
				trend := "MANUAL STOPPED — IDLE"
				if sig.Veto { trend = "VETO — " + truncate(sig.VetoReason, 40) }
				pct24h := 0.0
				if state.Price > 0 { pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10 }
				srv.UpdateInsight(gateway.InsightData{
					Symbol: cfg.Symbol, LastPrice: state.Price, OpenInterest: state.OI, LSRVal: lsr, Pct24h: pct24h,
					TrendState: trend, WhaleBias: "NEUTRAL", SignalStatus: "WAIT",
					Advice: "Bot Paused: Klik 'Start' di Dashboard untuk mengaktifkan trading otomatis",
					Timestamp: time.Now().Format("15:04:05"), Balance: balance,
					EntryTarget: printEntry, TPTarget: printTP, SLTarget: printSL,
				})
				continue
			}

			updateInsight(srv, cfg, sig, balance, dirStr, feed)

			if sig.Veto || dirStr == "WAIT" {
				lastAction = "WAIT"
				continue
			}

			// cooldown circuit breaker
			if time.Now().Before(cooldownUntil) {
				log.Printf("[main] Circuit breaker cooldown aktif sampai %s", cooldownUntil.Format("15:04:05"))
				continue
			}

			// [FIX-B] lastAction check dengan timeout
			// Jika arah sama tapi sudah melewati timeout, izinkan re-entry
			sameDirTimeout := dirStr == lastAction && time.Since(lastActionAt) < getLastActionTimeout()
			if sameDirTimeout {
				log.Printf("[main] Skip: arah %s sama dengan lastAction (%.0f detik lalu, timeout=%.0f detik)",
					dirStr,
					time.Since(lastActionAt).Seconds(),
					getLastActionTimeout().Seconds())
				continue
			}
			if dirStr == lastAction && time.Since(lastActionAt) >= getLastActionTimeout() {
				log.Printf("[main] lastAction timeout → allow re-entry %s", dirStr)
			}

			// RR check sesuai trading style
			rrLimit := 1.2
			switch strings.ToLower(cfg.TradingStyle) {
			case "scalping":   rrLimit = 0.8
			case "daytrading": rrLimit = 1.0
			case "swing":      rrLimit = 1.5
			}

			if sig.RiskReward < rrLimit {
				log.Printf("[main] Skip: RR=%.2f < %.2f (style=%s)", sig.RiskReward, rrLimit, cfg.TradingStyle)
				continue
			}

			// Update lastAction SEBELUM eksekusi
			lastAction = dirStr
			lastActionAt = time.Now()

			snapSig := *sig
			snapDir := dirStr

			// ── [3] EKSEKUSI TRADE ────────────────────────────────────────────────
			if cfg.DryRun {
				if activePaperTrade == nil {
					activePaperTrade = &gateway.Position{
						Side:       snapDir,
						EntryPrice: state.Price,
						TakeProfit: snapSig.TakeProfit,
						StopLoss:   snapSig.StopLoss,
						Time:       time.Now().Format("15:04:05"),
						Status:     "OPEN",
						PnL:        0.0,
					}
					log.Printf("[Paper] ✓ Virtual Order opened: %s %s @ %.4f | TP=%.4f SL=%.4f",
						snapDir, cfg.Symbol, state.Price, snapSig.TakeProfit, snapSig.StopLoss)
					srv.UpdatePositions(activePaperTrade, paperHistory)
				} else {
					log.Printf("[Paper] Skip: masih ada paper trade open (%s @ %.4f)",
						activePaperTrade.Side, activePaperTrade.EntryPrice)
				}
			} else {
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
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Printf("[main] Shutdown signal received — closing...")
	cancel()
	srv.Stop()
	time.Sleep(500 * time.Millisecond)
}

type orderExec interface {
	Execute(ctx context.Context, req interface{}) error
	FetchFreeUSDT(ctx context.Context) (float64, error)
}

func buildOrderRequest(sig shm.Signal, dir string, symbol string) interface{} {
	return map[string]interface{}{
		"Symbol": symbol, "Side": dir, "Entry": sig.Entry, "TakeProfit": sig.TakeProfit, "StopLoss": sig.StopLoss,
		"RiskReward": sig.RiskReward, "Confidence": sig.Confidence,
	}
}

func fetchBalance(ctx context.Context, exec orderExec) (float64, error) {
	return exec.FetchFreeUSDT(ctx)
}

func updateInsight(srv *gateway.Server, cfg Config, sig *shm.Signal, balance float64, action string, feed *market.Feed) {
	state := feed.State()
	lsr := state.LSR
	if lsr < 1e-9 { lsr = 1.0 }

	bias := "NEUTRAL"
	if lsr > 1.05 { bias = "LONG_HEAVY" } else if lsr < 0.95 { bias = "SHORT_HEAVY" }

	trend := "RANGING"
	if lsr > 1.05 { trend = "BULLISH" } else if lsr < 0.95 { trend = "BEARISH" }
	if sig.Veto { trend = "VETO — " + truncate(sig.VetoReason, 40) }

	advice := fmt.Sprintf("Consensus: WAIT (conf=%.3f)", sig.Confidence)
	if action != "WAIT" {
		advice = fmt.Sprintf("Signal %s! entry=%.4f TP=%.4f SL=%.4f RR=%.2f", action, sig.Entry, sig.TakeProfit, sig.StopLoss, sig.RiskReward)
	}

	pct24h := 0.0
	if state.Price > 0 && state.ATR14 > 0 { pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10 }

	dispEntry, dispTP, dispSL := sig.Entry, sig.TakeProfit, sig.StopLoss
	if sig.Veto || dispEntry == 0 {
		dispEntry, dispTP, dispSL = state.Price, state.Price, state.Price
	}

	srv.UpdateInsight(gateway.InsightData{
		Symbol: cfg.Symbol, LastPrice: state.Price, OpenInterest: state.OI, LSRVal: lsr, Pct24h: pct24h,
		TrendState: trend, WhaleBias: bias, SignalStatus: action, Advice: advice, Timestamp: time.Now().Format("15:04:05"),
		Balance: balance, EntryTarget: dispEntry, TPTarget: dispTP, SLTarget: dispSL,
	})
}

func truncate(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n] + "…"
}

func loadEnvFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil { return }
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") { continue }
		parts := strings.SplitN(line, "=", 2)
		k := strings.TrimSpace(parts[0])
		v := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
		if os.Getenv(k) == "" { os.Setenv(k, v) }
	}
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" { return v }
	return def
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil { return f }
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if i, err := strconv.Atoi(v); err == nil { return i }
	}
	return def
}

func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		val := strings.ToLower(v)
		return val == "1" || val == "true" || val == "on" || val == "yes"
	}
	return def
}

func execPath() string {
	p, err := os.Executable()
	if err != nil { return "." }
	return p
}
