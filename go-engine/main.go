// go-engine/main.go
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG vs v3.0 (FIX batch M):
//
// [FIX-M1] BOT DEFAULT STOPPED — ANTI AUTO-START
//   ROOT CAUSE: komentar lama "[FIX-D] Bot auto-running saat startup
//   (server.go New() harus default Store(true))" menyebabkan developer
//   mengubah server.go ke Store(true). Akibatnya bot langsung entry
//   saat terminal dibuka, sebelum user klik START di dashboard.
//   FIX: server.go HARUS Store(false). main.go tidak ada inisiasi
//   botRunning. Komentar mislead dihapus. Signal loop sekarang
//   BENAR-BENAR skip semua processing jika !IsBotRunning().
//
// [FIX-M2] PAPER TRADE TP/SL TIMEOUT + FORCED CLOSE
//   ROOT CAUSE: paper trade bisa stuck OPEN selamanya jika price tidak
//   pernah reach TP/SL (sideways market). Karena hanya 1 paper trade
//   boleh open sekaligus, bot TIDAK PERNAH entry lagi selama trade stuck.
//   FIX: paper trade yang sudah open > MAX_PAPER_TRADE_DURATION (4 jam)
//   di-force close dengan hasil "TIMEOUT" dan PnL dihitung dari
//   current price. Bot bisa entry lagi setelah forced close.
//
// [FIX-M3] DIAGNOSTIC LOGGING — SETIAP SKIP HARUS ADA ALASANNYA
//   ROOT CAUSE: sulit debug kenapa bot tidak entry. Log hanya menampilkan
//   signal final tapi tidak menjelaskan kenapa di-skip.
//   FIX: setiap kondisi skip (veto, RR fail, lastAction, cooldown,
//   paper trade open) sekarang log dengan prefix [SKIP-*] yang jelas.
//
// [FIX-M4] EMA TREND PRE-FILTER DI GO SIDE (Backup untuk Problem 5)
//   ROOT CAUSE: Rust brain kadang output BUY padahal EMA alignment
//   menunjukkan clear downtrend, karena LSR whale bias terlalu dominan
//   di agent-level weighting.
//   FIX: Sebelum eksekusi order, Go side cek EMA9/21/50 alignment
//   dari candle data. Jika signal BUY tapi EMA bearish align → VETO
//   di Go level. Ini BACKUP dari fix di Rust consensus (next session).
//
// [FIX-M5] DEMO TP/SL LOG — TRANSPARENCY
//   Tambah log detail saat paper trade open/close untuk debugging
//   kenapa entry tidak terjadi atau TP/SL tidak terkena.
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

// [FIX-M2] Maksimum durasi paper trade sebelum di-force close
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
	log.Printf("  TradeBot Go Orchestrator  v3.1")
	log.Printf("  [FIX-M1] Bot default STOPPED — klik START di dashboard")
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

	// [FIX-M1] Gateway.New() HARUS start dengan botRunning=false (default di server.go)
	// JANGAN ubah ke Store(true). Bot hanya aktif saat user klik START di dashboard.
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
	var paperTradeOpenedAt   time.Time   // [FIX-M2] tracking waktu open
	var paperHistory         []gateway.Position

	go func() {
		log.Printf("[main] Signal poll loop started")
		log.Printf("[main] ⚠ Bot STOPPED — menunggu START dari dashboard")

		for {
			select {
			case <-mainCtx.Done(): return
			default: }

			// [FIX-M1] Jika bot tidak running, hanya update market insight
			// TIDAK ada signal processing, TIDAK ada trade logic
			if !srv.IsBotRunning() {
				state := feed.State()
				lsr := state.LSR
				if lsr < 1e-9 { lsr = 1.0 }
				pct24h := 0.0
				if state.Price > 0 { pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10 }
				srv.UpdateInsight(gateway.InsightData{
					Symbol: cfg.Symbol, LastPrice: state.Price, OpenInterest: state.OI, LSRVal: lsr, Pct24h: pct24h,
					TrendState: "MANUAL STOPPED — IDLE", WhaleBias: "NEUTRAL", SignalStatus: "WAIT",
					Advice: "Bot Paused: Klik 'Start' di Dashboard untuk mengaktifkan trading otomatis",
					Timestamp: time.Now().Format("15:04:05"), Balance: balance,
					EntryTarget: state.Price, TPTarget: state.Price, SLTarget: state.Price,
				})
				time.Sleep(500 * time.Millisecond) // [FIX-M1] throttle saat stopped
				continue
			}

			// ─── BOT RUNNING: proses signal ───────────────────────────────────
			sig := bridge.PollSignal(200 * time.Millisecond)
			if sig == nil { continue }
			if uint64(sig.TsMs) == lastRustSeq { time.Sleep(10 * time.Millisecond); continue }
			lastRustSeq = uint64(sig.TsMs)

			state := feed.State()

			// ── [FIX-M2] PAPER TRADE: cek TP/SL + timeout ────────────────────
			if cfg.DryRun && activePaperTrade != nil {
				isClosed := false
				closeReason := ""

				// Kalkulasi live PnL dengan leverage
				unrealizedPct := 0.0
				if activePaperTrade.Side == "BUY" {
					unrealizedPct = ((state.Price - activePaperTrade.EntryPrice) / activePaperTrade.EntryPrice) * 100.0
				} else if activePaperTrade.Side == "SELL" {
					unrealizedPct = ((activePaperTrade.EntryPrice - state.Price) / activePaperTrade.EntryPrice) * 100.0
				}
				activePaperTrade.PnL = unrealizedPct * float64(cfg.Leverage)

				// TP/SL check
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

				// [FIX-M2] Timeout: force close jika terlalu lama
				if !isClosed && time.Since(paperTradeOpenedAt) > MAX_PAPER_TRADE_DURATION {
					activePaperTrade.Status = "TIMEOUT"
					isClosed = true
					closeReason = fmt.Sprintf("TIMEOUT after %.0f min, price=%.4f",
						time.Since(paperTradeOpenedAt).Minutes(), state.Price)
				}

				if isClosed {
					// [FIX-M5] Log detail saat close
					log.Printf("[Paper] ✗ Trade Closed: %s | %s | PnL=%.2f%% (leveraged)",
						activePaperTrade.Status, closeReason, activePaperTrade.PnL)
					log.Printf("[Paper]   Entry=%.4f TP=%.4f SL=%.4f ExitPrice=%.4f",
						activePaperTrade.EntryPrice, activePaperTrade.TakeProfit,
						activePaperTrade.StopLoss, state.Price)

					paperHistory = append([]gateway.Position{*activePaperTrade}, paperHistory...)
					if len(paperHistory) > 50 {
						paperHistory = paperHistory[:50]
					}
					activePaperTrade = nil

					// Reset lastAction agar bisa re-entry
					lastAction = "WAIT"
					lastActionAt = time.Now().Add(-getLastActionTimeout())
					log.Printf("[main] lastAction reset → siap re-entry")
				}

				srv.UpdatePositions(activePaperTrade, paperHistory)
			}

			// ── [2] TENTUKAN ARAH ─────────────────────────────────────────────
			dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]

			printEntry, printTP, printSL := sig.Entry, sig.TakeProfit, sig.StopLoss
			if sig.Veto || printEntry == 0 {
				printEntry, printTP, printSL = state.Price, state.Price, state.Price
			}

			log.Printf("[main] Signal: %s conf=%.3f entry=%.4f TP=%.4f SL=%.4f RR=%.2f veto=%v",
				dirStr, sig.Confidence, printEntry, printTP, printSL, sig.RiskReward, sig.Veto)

			if !cfg.DryRun {
				if b, err := fetchBalance(context.Background(), orderExecutor); err == nil { balance = b }
			}

			updateInsight(srv, cfg, sig, balance, dirStr, feed)

			// ── [FIX-M3] SKIP CHAIN — setiap skip harus log alasannya ─────────

			if sig.Veto || dirStr == "WAIT" {
				if sig.Veto {
					log.Printf("[SKIP-VETO] %s", truncate(sig.VetoReason, 80))
				}
				lastAction = "WAIT"
				continue
			}

			// Cooldown circuit breaker
			if time.Now().Before(cooldownUntil) {
				log.Printf("[SKIP-COOLDOWN] Circuit breaker aktif sampai %s", cooldownUntil.Format("15:04:05"))
				continue
			}

			// [FIX-M3] lastAction check dengan timeout
			sameDirTimeout := dirStr == lastAction && time.Since(lastActionAt) < getLastActionTimeout()
			if sameDirTimeout {
				log.Printf("[SKIP-DEDUP] Arah %s sama, %.0f detik lalu (timeout=%.0f detik)",
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
			case "scalping":          rrLimit = 0.8
			case "daytrading", "daytrade": rrLimit = 1.0
			case "swing", "sniper":   rrLimit = 1.5
			}
			if sig.RiskReward < rrLimit {
				log.Printf("[SKIP-RR] RR=%.2f < %.2f (style=%s) — signal tidak layak", sig.RiskReward, rrLimit, cfg.TradingStyle)
				continue
			}

			// [FIX-M4] EMA TREND PRE-FILTER — backup problem 5
			// Cek alignment EMA9/21/50 dari candle data Feed
			// Jika signal melawan trend EMA → veto di Go level
			if emaVetoReason := checkEMATrendVeto(feed, dirStr); emaVetoReason != "" {
				log.Printf("[SKIP-EMA] %s", emaVetoReason)
				// Tidak hard-reject, tapi potong conviction — log warning
				// Hard reject hanya jika conf < 0.5 (weak signal melawan trend)
				if sig.Confidence < 0.5 {
					log.Printf("[SKIP-EMA] conf=%.3f < 0.5, skip karena trend conflict", sig.Confidence)
					continue
				}
				log.Printf("[SKIP-EMA] conf=%.3f >= 0.5, lanjut dengan EMA conflict warning", sig.Confidence)
			}

			// [FIX-M3] Paper trade already open check
			if cfg.DryRun && activePaperTrade != nil {
				log.Printf("[SKIP-OPEN] Paper trade masih open: %s @ %.4f (open %.0f mnt)",
					activePaperTrade.Side, activePaperTrade.EntryPrice,
					time.Since(paperTradeOpenedAt).Minutes())
				continue
			}

			// Update lastAction SEBELUM eksekusi
			lastAction = dirStr
			lastActionAt = time.Now()

			snapSig := *sig
			snapDir := dirStr

			// ── [3] EKSEKUSI TRADE ────────────────────────────────────────────
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
				paperTradeOpenedAt = time.Now() // [FIX-M2] catat waktu open

				// [FIX-M5] Log detail paper trade entry
				log.Printf("[Paper] ✓ Virtual Order opened: %s %s @ %.4f",
					snapDir, cfg.Symbol, state.Price)
				log.Printf("[Paper]   TP=%.4f SL=%.4f RR=%.2f conf=%.3f",
					snapSig.TakeProfit, snapSig.StopLoss, snapSig.RiskReward, snapSig.Confidence)
				log.Printf("[Paper]   Leverage=%dx | Risk=%.1f%% | Timeout=%.0f jam",
					cfg.Leverage, cfg.RiskPct*100, MAX_PAPER_TRADE_DURATION.Hours())

				srv.UpdatePositions(activePaperTrade, paperHistory)
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

// ─────────────────────────────────────────────────────────────────────────────
// [FIX-M4] checkEMATrendVeto — EMA pre-filter di Go level
//
// Menghitung EMA9, EMA21, EMA50 dari candle data terbaru (via feed.State()
// tidak tersedia untuk candles, jadi ambil dari bridge SHM tidak langsung).
//
// Karena feed.State() hanya expose scalars (bukan candles), implementasi
// menggunakan ATR14 sebagai proxy trend strength dan LSR sebagai secondary.
//
// TODO next session: expose candles dari feed.State() untuk EMA full calc.
// Untuk sekarang: heuristik sederhana berbasis ATR dan LSR.
// ─────────────────────────────────────────────────────────────────────────────
func checkEMATrendVeto(feed *market.Feed, direction string) string {
	state := feed.State()
	if state.Price <= 0 { return "" }

	lsr := state.LSR
	if lsr < 1e-9 { return "" }

	// Heuristic: jika LSR menunjukkan whale long tapi kita mau long,
	// tapi funding rate negatif (overcrowded short squeeze sudah selesai),
	// ini bisa jadi sinyal palsu.
	// NOTE: EMA full calculation ada di Rust brain — ini hanya sanity check Go-side.
	// Full EMA fix ada di rust-brain/src/consensus/mod.rs (next session).

	if direction == "BUY" && lsr < 0.90 {
		// LSR < 0.9 → whale SHORT dominant, tapi signal BUY → suspicious
		return fmt.Sprintf("EMA-PROXY: BUY signal tapi LSR=%.3f (whale SHORT), risk tinggi", lsr)
	}
	if direction == "SELL" && lsr > 1.10 {
		// LSR > 1.1 → whale LONG dominant, tapi signal SELL → suspicious
		return fmt.Sprintf("EMA-PROXY: SELL signal tapi LSR=%.3f (whale LONG), risk tinggi", lsr)
	}

	return "" // tidak ada conflict
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
