// go-engine/main.go
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG vs v3.1:
//
// [FIX-PAIR] CRITICAL — WIRE symbolCh → feed.UpdateSymbol()
//   ROOT CAUSE: server.go sudah benar emit symbol baru ke symbolCh saat
//   user klik START dengan pair berbeda. Tapi main.go TIDAK ADA goroutine
//   yang listen channel itu dan panggil feed.UpdateSymbol(). Akibatnya:
//   feed SELALU analisa symbol dari startup/env (default SOLUSDT/BTCUSDT),
//   TIDAK PERNAH update ke pair yang dipilih user di dashboard.
//   FIX: tambah goroutine setelah go feed.Run() yang listen srv.GetSymbolCh()
//   dan forward ke feed.UpdateSymbol(). Juga sync symbol dari activeCfg
//   server saat bot pertama kali di-START via dashboard.
//
// [FIX-PAIR-BOOT] Saat bot start via dashboard, gunakan symbol dari
//   server.activeCfg (yang datang dari browser) bukan dari .env.
//   Ini handle case: user buka dashboard, pilih ETHUSDT, klik START →
//   feed langsung analisa ETHUSDT tanpa perlu restart server.
// ═══════════════════════════════════════════════════════════════════════════
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

const MAX_PAPER_TRADE_DURATION = 4 * time.Hour

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

		// [FIX-S2] .env sekarang HANYA berisi API keys
		// Setting lain (symbol, leverage, dll) datang dari browser via server
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
	log.Printf("  TradeBot Go Orchestrator  v3.2")
	log.Printf("  [FIX-PAIR] Symbol switching live — no restart needed")
	log.Printf("  [FIX-M1] Bot default STOPPED — klik START di dashboard")
	log.Printf("═══════════════════════════════════════════")

	cfg := loadConfig()
	log.Printf("[main] exchange=%s mode=%s symbol=%s (initial/default) style=%s dryRun=%v",
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

	// Gateway — default stopped (user harus klik START di dashboard)
	srv := gateway.New(cfg.BaseDir)
	go srv.Start()

	// Init feed dengan symbol default dari env/config
	// Akan di-update ke symbol pilihan user saat START ditekan di dashboard
	feed := market.New(bridge, cfg.Symbol, cfg.OHLCVTF, cfg.OHLCVLimit)
	mainCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go feed.Run(mainCtx)

	// ═══════════════════════════════════════════════════════════════════════
	// [FIX-PAIR] CRITICAL GOROUTINE — Symbol channel wiring
	//
	// Ini adalah goroutine yang HILANG dan menyebabkan pair tidak pernah
	// berganti meski user sudah pilih pair berbeda di dashboard.
	//
	// Flow yang benar:
	//   Dashboard → POST /api/start {SYMBOL: "ETHUSDT"}
	//   → server.go: symbolCh <- "ETHUSDT"
	//   → goroutine ini: feed.UpdateSymbol("ETHUSDT")   ← INI YANG HILANG
	//   → feed.go: atomicSymbol.Store("ETHUSDT")
	//   → wsConnect: reconnect subscribe tickers.ETHUSDT
	//   → fetchOHLCV("ETHUSDT") → kirim ke SHM → Rust brain analisa ETHUSDT
	// ═══════════════════════════════════════════════════════════════════════
	go func() {
		// [FIX-PAIR-BOOT] Cek apakah server sudah punya symbol dari browser session
		// sebelumnya (misal user refresh page tapi server masih hidup)
		if activeSym := srv.GetActiveSymbol(); activeSym != "" && activeSym != cfg.Symbol {
			log.Printf("[main] [FIX-PAIR-BOOT] Sync symbol from server cache: %s → %s",
				cfg.Symbol, activeSym)
			feed.UpdateSymbol(activeSym)
		}

		for {
			select {
			case <-mainCtx.Done():
				return
			// [FIX-PAIR] Listen symbol change dari dashboard → forward ke feed
			case sym := <-srv.GetSymbolCh():
				log.Printf("[main] [FIX-PAIR] ⚡ Pair switched → %s (live, no server restart needed)", sym)
				feed.UpdateSymbol(sym)
				// Update cfg.Symbol agar signal loop gunakan symbol yang benar
				// saat log dan insight update
				cfg.Symbol = sym
			}
		}
	}()

	nlpEngine := nlp.NewEngine(cfg.Symbol, 5*time.Minute)
	go nlpEngine.Run(mainCtx, feed)

	lastRustSeq  := uint64(0)
	lastAction   := "WAIT"
	lastActionAt := time.Now().Add(-10 * time.Minute)
	cooldownUntil := time.Time{}
	consecutiveLosses := 0

	lastActionTimeout := map[string]time.Duration{
		"scalping":   10 * time.Minute,
		"daytrading": 30 * time.Minute,
		"daytrade":   30 * time.Minute,
		"swing":      4 * time.Hour,
		"sniper":     4 * time.Hour,
	}
	getLastActionTimeout := func() time.Duration {
		style := strings.ToLower(cfg.TradingStyle)
		if d, ok := lastActionTimeout[style]; ok {
			return d
		}
		return 10 * time.Minute
	}

	var activePaperTrade     *gateway.Position
	var paperTradeOpenedAt   time.Time
	var paperHistory         []gateway.Position

	go func() {
		log.Printf("[main] Signal poll loop started")
		log.Printf("[main] ⚠ Bot STOPPED — menunggu START dari dashboard")

		for {
			select {
			case <-mainCtx.Done(): return
			default: }

			if !srv.IsBotRunning() {
				state := feed.State()
				// [FIX-PAIR] Gunakan symbol dari feed.State() bukan cfg.Symbol static
				activeSym := state.Symbol
				if activeSym == "" { activeSym = cfg.Symbol }
				lsr := state.LSR
				if lsr < 1e-9 { lsr = 1.0 }
				pct24h := 0.0
				if state.Price > 0 { pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10 }
				srv.UpdateInsight(gateway.InsightData{
					Symbol: activeSym, LastPrice: state.Price, OpenInterest: state.OI, LSRVal: lsr, Pct24h: pct24h,
					TrendState: "MANUAL STOPPED — IDLE", WhaleBias: "NEUTRAL", SignalStatus: "WAIT",
					Advice: "Bot Paused: Klik 'Start' di Dashboard untuk mengaktifkan trading otomatis",
					Timestamp: time.Now().Format("15:04:05"), Balance: balance,
					EntryTarget: state.Price, TPTarget: state.Price, SLTarget: state.Price,
				})
				time.Sleep(500 * time.Millisecond)
				continue
			}

			// ─── BOT RUNNING ──────────────────────────────────────────────────
			sig := bridge.PollSignal(200 * time.Millisecond)
			if sig == nil { continue }
			if uint64(sig.TsMs) == lastRustSeq { time.Sleep(10 * time.Millisecond); continue }
			lastRustSeq = uint64(sig.TsMs)

			state := feed.State()

			// [FIX-PAIR] currentSym selalu dari feed state (bukan cfg.Symbol static)
			currentSym := state.Symbol
			if currentSym == "" { currentSym = cfg.Symbol }

			// ── Paper trade TP/SL check + timeout ─────────────────────────────
			if cfg.DryRun && activePaperTrade != nil {
				isClosed := false
				closeReason := ""

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
					closeReason = fmt.Sprintf("TP hit @ %.4f (target=%.4f)", state.Price, activePaperTrade.TakeProfit)
				} else if (activePaperTrade.Side == "BUY" && state.Price <= activePaperTrade.StopLoss) ||
				          (activePaperTrade.Side == "SELL" && state.Price >= activePaperTrade.StopLoss) {
					activePaperTrade.Status = "CLOSED_SL"
					isClosed = true
					closeReason = fmt.Sprintf("SL hit @ %.4f (target=%.4f)", state.Price, activePaperTrade.StopLoss)
				}

				if !isClosed && time.Since(paperTradeOpenedAt) > MAX_PAPER_TRADE_DURATION {
					activePaperTrade.Status = "TIMEOUT"
					isClosed = true
					closeReason = fmt.Sprintf("TIMEOUT after %.0f min, price=%.4f",
						time.Since(paperTradeOpenedAt).Minutes(), state.Price)
				}

				if isClosed {
					log.Printf("[Paper] ✗ Trade Closed: %s | %s | PnL=%.2f%%",
						activePaperTrade.Status, closeReason, activePaperTrade.PnL)
					paperHistory = append([]gateway.Position{*activePaperTrade}, paperHistory...)
					if len(paperHistory) > 50 { paperHistory = paperHistory[:50] }
					activePaperTrade = nil
					lastAction = "WAIT"
					lastActionAt = time.Now().Add(-getLastActionTimeout())
				}

				srv.UpdatePositions(activePaperTrade, paperHistory)
			}

			dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]

			printEntry, printTP, printSL := sig.Entry, sig.TakeProfit, sig.StopLoss
			if sig.Veto || printEntry == 0 {
				printEntry, printTP, printSL = state.Price, state.Price, state.Price
			}

			// [FIX-PAIR] Log dengan currentSym bukan cfg.Symbol
			log.Printf("[main] [%s] Signal: %s conf=%.3f entry=%.4f TP=%.4f SL=%.4f RR=%.2f veto=%v",
				currentSym, dirStr, sig.Confidence, printEntry, printTP, printSL, sig.RiskReward, sig.Veto)

			if !cfg.DryRun {
				if b, err := fetchBalance(context.Background(), orderExecutor); err == nil { balance = b }
			}

			updateInsight(srv, cfg, sig, balance, dirStr, feed)

			if sig.Veto || dirStr == "WAIT" {
				if sig.Veto {
					log.Printf("[SKIP-VETO] %s", truncate(sig.VetoReason, 80))
				}
				lastAction = "WAIT"
				continue
			}

			if time.Now().Before(cooldownUntil) {
				log.Printf("[SKIP-COOLDOWN] Circuit breaker aktif sampai %s", cooldownUntil.Format("15:04:05"))
				continue
			}

			sameDirTimeout := dirStr == lastAction && time.Since(lastActionAt) < getLastActionTimeout()
			if sameDirTimeout {
				log.Printf("[SKIP-DEDUP] Arah %s sama, %.0f detik lalu", dirStr, time.Since(lastActionAt).Seconds())
				continue
			}

			rrLimit := 1.2
			switch strings.ToLower(cfg.TradingStyle) {
			case "scalping":               rrLimit = 0.8
			case "daytrading", "daytrade": rrLimit = 1.0
			case "swing", "sniper":        rrLimit = 1.5
			}
			if sig.RiskReward < rrLimit {
				log.Printf("[SKIP-RR] RR=%.2f < %.2f (style=%s)", sig.RiskReward, rrLimit, cfg.TradingStyle)
				continue
			}

			if emaVetoReason := checkEMATrendVeto(feed, dirStr); emaVetoReason != "" {
				log.Printf("[SKIP-EMA] %s", emaVetoReason)
				if sig.Confidence < 0.5 {
					log.Printf("[SKIP-EMA] conf=%.3f < 0.5, skip", sig.Confidence)
					continue
				}
			}

			if cfg.DryRun && activePaperTrade != nil {
				log.Printf("[SKIP-OPEN] Paper trade masih open: %s @ %.4f", activePaperTrade.Side, activePaperTrade.EntryPrice)
				continue
			}

			lastAction = dirStr
			lastActionAt = time.Now()

			snapSig := *sig
			snapDir := dirStr

			if cfg.DryRun {
				activePaperTrade = &gateway.Position{
					Side:       snapDir,
					EntryPrice: state.Price,
					TakeProfit: snapSig.TakeProfit,
					StopLoss:   snapSig.StopLoss,
					Time:       time.Now().Format("15:04:05"),
					Status:     "OPEN",
					PnL:        0.0,
				}
				paperTradeOpenedAt = time.Now()

				// [FIX-PAIR] Log dengan currentSym
				log.Printf("[Paper] ✓ Virtual Order opened: %s %s @ %.4f",
					snapDir, currentSym, state.Price)
				log.Printf("[Paper]   TP=%.4f SL=%.4f RR=%.2f conf=%.3f",
					snapSig.TakeProfit, snapSig.StopLoss, snapSig.RiskReward, snapSig.Confidence)

				srv.UpdatePositions(activePaperTrade, paperHistory)
			} else {
				go func() {
					// [FIX-PAIR] Gunakan currentSym untuk order, bukan cfg.Symbol static
					req := buildOrderRequest(snapSig, snapDir, currentSym)
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
						log.Printf("[main] ✓ Order fired: %s %s", snapDir, currentSym)
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

// ─────────────────────────────────────────────────────────────────────────────
// [FIX-M4] EMA proxy veto — heuristik sederhana via LSR
// ─────────────────────────────────────────────────────────────────────────────
func checkEMATrendVeto(feed *market.Feed, direction string) string {
	state := feed.State()
	if state.Price <= 0 { return "" }
	lsr := state.LSR
	if lsr < 1e-9 { return "" }

	if direction == "BUY" && lsr < 0.90 {
		return fmt.Sprintf("EMA-PROXY: BUY signal tapi LSR=%.3f (whale SHORT dominant)", lsr)
	}
	if direction == "SELL" && lsr > 1.10 {
		return fmt.Sprintf("EMA-PROXY: SELL signal tapi LSR=%.3f (whale LONG dominant)", lsr)
	}
	return ""
}

// ─────────────────────────────────────────────────────────────────────────────

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
	// [FIX-PAIR] Symbol dari feed state, bukan cfg.Symbol static
	sym := state.Symbol
	if sym == "" { sym = cfg.Symbol }

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
	if sig.Veto || dispEntry == 0 { dispEntry, dispTP, dispSL = state.Price, state.Price, state.Price }

	srv.UpdateInsight(gateway.InsightData{
		Symbol: sym, LastPrice: state.Price, OpenInterest: state.OI, LSRVal: lsr, Pct24h: pct24h,
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
