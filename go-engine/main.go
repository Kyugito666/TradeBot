// go-engine/main.go
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG vs v3.2:
//
// [FIX-RT1] READ bot_runtime.conf IN loadConfig()
//   ROOT CAUSE: server.go [FIX-S2] menulis API keys saja ke .env.
//   Semua setting lain (EXCHANGE_MODE, DRY_RUN, LEVERAGE, TRADING_STYLE,
//   RISK_PCT, EXCHANGE, SYMBOL) ditulis ke bot_runtime.conf via
//   server.writeRuntimeConfig(). Tapi loadConfig() HANYA baca .env →
//   semua setting fallback ke default hardcode di sini:
//     - DryRun  default true → balance $10k dummy, order diblokir
//     - EXCHANGE_MODE default "demo" → selalu bybit testnet, mode real diabaikan
//     - LEVERAGE default 10 → leverage setting dari dashboard diabaikan
//     - TRADING_STYLE → sudah dibaca per-evaluate() oleh consensus/mod.rs ✓
//   FIX: loadEnvFile("bot_runtime.conf") SESUDAH loadEnvFile(".env").
//   loadEnvFile() hanya set env var jika belum ada (if os.Getenv == ""),
//   jadi .env API keys tidak di-overwrite oleh bot_runtime.conf.
//
// [FIX-RT2] DryRun DEFAULT DIUBAH false
//   Sebelumnya: DryRun: envBool("DRY_RUN", true)  ← default ON
//   Sesudah:    DryRun: envBool("DRY_RUN", false) ← default OFF
//   Alasan: user yang tidak set DRY_RUN di dashboard harusnya masuk real mode.
//   Jika user mau dry run, toggle di dashboard → bot_runtime.conf → terbaca.
//   CATATAN: tetap aman karena DryRun=false + DRY_RUN tidak di set di env
//   hanya berarti "coba eksekusi order" — order gagal jika API key kosong.
//
// [FIX-RT3] LOG AKTUAL CONFIG SETELAH LOAD
//   Tambah log lengkap setelah loadConfig() selesai baca kedua file,
//   sehingga user bisa verify di bot.log bahwa settings dari dashboard
//   benar-benar terbaca. Sebelumnya log hanya menampilkan initial/default
//   tanpa konfirmasi bahwa bot_runtime.conf sudah dibaca.
//
// [FIX-PAIR] WIRE symbolCh → feed.UpdateSymbol() — dipertahankan dari v3.2
// [FIX-PAIR-BOOT] Sync symbol from server cache — dipertahankan dari v3.2
// ═══════════════════════════════════════════════════════════════════════════
package main

import (
	"context"
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
	// [FIX-RT1] Urutan load: .env dulu (API keys), lalu bot_runtime.conf (settings).
	// loadEnvFile() hanya set jika env var belum ada → tidak overwrite API keys.
	loadEnvFile(".env")
	loadEnvFile("bot_runtime.conf") // ← INI YANG HILANG, root cause semua bug settings

	c := Config{
		Exchange:     envStr("EXCHANGE", "bybit"),
		ExchangeMode: envStr("EXCHANGE_MODE", "demo"),
		Symbol:       envStr("SYMBOL", "SOLUSDT"),
		OHLCVTF:      "5",
		OHLCVLimit:   200,
		RiskPct:      envFloat("RISK_PCT", 0.03),
		Leverage:     envInt("LEVERAGE", 10),
		// [FIX-RT2] Default false — jika bot_runtime.conf ada DRY_RUN=1 maka true,
		// jika tidak ada sama sekali, default real (false).
		DryRun:       envBool("DRY_RUN", false),
		TradingStyle: envStr("TRADING_STYLE", "scalping"),

		// API keys hanya dari .env
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
	log.Printf("  TradeBot Go Orchestrator  v3.3")
	log.Printf("  [FIX-RT1] Reads bot_runtime.conf — settings survive restart")
	log.Printf("  [FIX-RT2] DryRun default=false (set via dashboard)")
	log.Printf("  [FIX-PAIR] Symbol switching live — no restart needed")
	log.Printf("═══════════════════════════════════════════")

	cfg := loadConfig()

	// [FIX-RT3] Log aktual config yang dibaca dari kedua file
	log.Printf("[main] ═══ CONFIG LOADED ═══════════════════════════════")
	log.Printf("[main]   exchange     = %s", cfg.Exchange)
	log.Printf("[main]   mode         = %s", cfg.ExchangeMode)
	log.Printf("[main]   symbol       = %s (initial/default)", cfg.Symbol)
	log.Printf("[main]   leverage     = %dx", cfg.Leverage)
	log.Printf("[main]   risk_pct     = %.1f%%", cfg.RiskPct*100)
	log.Printf("[main]   dry_run      = %v", cfg.DryRun)
	log.Printf("[main]   trading_style= %s", cfg.TradingStyle)
	log.Printf("[main]   bybit_key    = %s", maskKey(cfg.BybitAPIKey))
	log.Printf("[main]   bybit_demo   = %s", maskKey(cfg.BybitDemoKey))
	log.Printf("[main]   mexc_key     = %s", maskKey(cfg.MexcAPIKey))
	log.Printf("[main] ═══════════════════════════════════════════════════")

	bridge, err := shm.Open()
	if err != nil {
		log.Fatalf("[main] SHM open failed: %v", err)
	}
	defer bridge.Close()
	log.Printf("[main] SHM /tradebot_v3 ready")

	// ── Exchange executor setup ───────────────────────────────────────────────
	var orderExecutor orderExec
	switch strings.ToLower(cfg.Exchange) {
	case "bybit":
		apiKey, apiSecret := cfg.BybitAPIKey, cfg.BybitAPISecret
		testnet := strings.ToLower(cfg.ExchangeMode) == "demo"
		if testnet {
			// Demo mode: gunakan demo/testnet API key
			if cfg.BybitDemoKey != "" {
				apiKey, apiSecret = cfg.BybitDemoKey, cfg.BybitDemoSecret
				log.Printf("[main] Bybit DEMO mode — menggunakan demo API key")
			} else {
				log.Printf("[main] WARNING: Bybit DEMO mode tapi BYBIT_DEMO_API_KEY kosong")
			}
		} else {
			// Real mode: pastikan real API key tersedia
			if apiKey == "" {
				log.Printf("[main] WARNING: Bybit REAL mode tapi BYBIT_REAL_API_KEY kosong")
			} else {
				log.Printf("[main] Bybit REAL mode — menggunakan real API key")
			}
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
		if cfg.MexcAPIKey == "" {
			log.Printf("[main] WARNING: MEXC exchange dipilih tapi MEXC_API_KEY kosong")
		}
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

	// ── Initial balance fetch ─────────────────────────────────────────────────
	ctx := context.Background()
	balance := 0.0
	if !cfg.DryRun {
		if b, err := fetchBalance(ctx, orderExecutor); err == nil {
			balance = b
			log.Printf("[main]   Exchange connected | exchange=%s mode=%s | free_USDT=%.2f",
				cfg.Exchange, cfg.ExchangeMode, balance)
		} else {
			log.Printf("[main] API Auth Error: %v", err)
			log.Printf("[main] Fallback ke paper balance $0 (periksa API key di dashboard)")
			// Jangan hardcode 10000 — tampilkan 0 agar user tau ada masalah auth
			balance = 0.0
		}
	} else {
		balance = 10000.0
		log.Printf("[main]   DRY RUN | exchange=%s mode=%s | virtual_USDT=%.2f",
			cfg.Exchange, cfg.ExchangeMode, balance)
	}

	// ── Gateway server ────────────────────────────────────────────────────────
	srv := gateway.New(cfg.BaseDir)
	go srv.Start()

	// ── Market feed ───────────────────────────────────────────────────────────
	feed := market.New(bridge, cfg.Symbol, cfg.OHLCVTF, cfg.OHLCVLimit)
	mainCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go feed.Run(mainCtx)

	// ── [FIX-PAIR] Symbol channel wiring ────────────────────────────────────
	go func() {
		if activeSym := srv.GetActiveSymbol(); activeSym != "" && activeSym != cfg.Symbol {
			log.Printf("[main] [FIX-PAIR-BOOT] Sync symbol from server cache: %s → %s",
				cfg.Symbol, activeSym)
			feed.UpdateSymbol(activeSym)
		}

		for {
			select {
			case <-mainCtx.Done():
				return
			case sym := <-srv.GetSymbolCh():
				log.Printf("[main] [FIX-PAIR] ⚡ Pair switched → %s (live, no server restart needed)", sym)
				feed.UpdateSymbol(sym)
				cfg.Symbol = sym
			}
		}
	}()

	// ── NLP engine ───────────────────────────────────────────────────────────
	nlpEngine := nlp.NewEngine(cfg.Symbol, 5*time.Minute)
	go nlpEngine.Run(mainCtx, feed)

	// ── Signal loop vars ──────────────────────────────────────────────────────
	lastRustSeq        := uint64(0)
	lastAction         := "WAIT"
	lastActionAt       := time.Now().Add(-10 * time.Minute)
	cooldownUntil      := time.Time{}
	consecutiveLosses  := 0

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

	var activePaperTrade   *gateway.Position
	var paperTradeOpenedAt time.Time
	var paperHistory       []gateway.Position

	// ── Main signal loop ──────────────────────────────────────────────────────
	go func() {
		log.Printf("[main] Signal poll loop started")
		log.Printf("[main] ⚠ Bot STOPPED — menunggu START dari dashboard")

		for {
			select {
			case <-mainCtx.Done():
				return
			default:
			}

			if !srv.IsBotRunning() {
				state := feed.State()
				activeSym := state.Symbol
				if activeSym == "" {
					activeSym = cfg.Symbol
				}
				lsr := state.LSR
				if lsr < 1e-9 {
					lsr = 1.0
				}
				pct24h := 0.0
				if state.Price > 0 {
					pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10
				}
				srv.UpdateInsight(gateway.InsightData{
					Symbol: activeSym, LastPrice: state.Price, OpenInterest: state.OI,
					LSRVal: lsr, Pct24h: pct24h,
					TrendState:   "MANUAL STOPPED — IDLE",
					WhaleBias:    "NEUTRAL",
					SignalStatus: "WAIT",
					Advice:       "Bot Paused: Klik 'Start' di Dashboard untuk mengaktifkan trading otomatis",
					Timestamp:    time.Now().Format("15:04:05"),
					Balance:      balance,
					EntryTarget:  state.Price,
					TPTarget:     state.Price,
					SLTarget:     state.Price,
				})
				time.Sleep(500 * time.Millisecond)
				continue
			}

			// ─── BOT RUNNING ──────────────────────────────────────────────────
			sig := bridge.PollSignal(200 * time.Millisecond)
			if sig == nil {
				continue
			}
			if uint64(sig.TsMs) == lastRustSeq {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			lastRustSeq = uint64(sig.TsMs)

			state := feed.State()
			currentSym := state.Symbol
			if currentSym == "" {
				currentSym = cfg.Symbol
			}

			// ── Paper trade TP/SL check + timeout ────────────────────────────
			if cfg.DryRun && activePaperTrade != nil {
				isClosed    := false
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
					isClosed    = true
					closeReason = fmt.Sprintf("TP hit @ %.4f (target=%.4f)", state.Price, activePaperTrade.TakeProfit)
				} else if (activePaperTrade.Side == "BUY" && state.Price <= activePaperTrade.StopLoss) ||
					(activePaperTrade.Side == "SELL" && state.Price >= activePaperTrade.StopLoss) {
					activePaperTrade.Status = "CLOSED_SL"
					isClosed    = true
					closeReason = fmt.Sprintf("SL hit @ %.4f (target=%.4f)", state.Price, activePaperTrade.StopLoss)
				}

				if !isClosed && time.Since(paperTradeOpenedAt) > MAX_PAPER_TRADE_DURATION {
					activePaperTrade.Status = "TIMEOUT"
					isClosed    = true
					closeReason = fmt.Sprintf("TIMEOUT after %.0f min, price=%.4f",
						time.Since(paperTradeOpenedAt).Minutes(), state.Price)
				}

				if isClosed {
					log.Printf("[Paper] ✗ Trade Closed: %s | %s | PnL=%.2f%%",
						activePaperTrade.Status, closeReason, activePaperTrade.PnL)
					paperHistory = append([]gateway.Position{*activePaperTrade}, paperHistory...)
					if len(paperHistory) > 50 {
						paperHistory = paperHistory[:50]
					}
					activePaperTrade = nil
					lastAction  = "WAIT"
					lastActionAt = time.Now().Add(-getLastActionTimeout())
				}

				srv.UpdatePositions(activePaperTrade, paperHistory)
			}

			dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]

			printEntry, printTP, printSL := sig.Entry, sig.TakeProfit, sig.StopLoss
			if sig.Veto || printEntry == 0 {
				printEntry, printTP, printSL = state.Price, state.Price, state.Price
			}

			log.Printf("[main] [%s] Signal: %s conf=%.3f entry=%.4f TP=%.4f SL=%.4f RR=%.2f veto=%v",
				currentSym, dirStr, sig.Confidence, printEntry, printTP, printSL, sig.RiskReward, sig.Veto)

			// Refresh balance dari API jika real mode
			if !cfg.DryRun {
				if b, err := fetchBalance(context.Background(), orderExecutor); err == nil {
					balance = b
				}
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

			if dirStr == lastAction && time.Since(lastActionAt) < getLastActionTimeout() {
				log.Printf("[SKIP-DEDUP] Arah %s sama, %.0f detik lalu", dirStr, time.Since(lastActionAt).Seconds())
				continue
			}

			rrLimit := 1.2
			switch strings.ToLower(cfg.TradingStyle) {
			case "scalping":
				rrLimit = 0.8
			case "daytrading", "daytrade":
				rrLimit = 1.0
			case "swing", "sniper":
				rrLimit = 1.5
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

			lastAction  = dirStr
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

				log.Printf("[Paper] ✓ Virtual Order opened: %s %s @ %.4f",
					snapDir, currentSym, state.Price)
				log.Printf("[Paper]   TP=%.4f SL=%.4f RR=%.2f conf=%.3f",
					snapSig.TakeProfit, snapSig.StopLoss, snapSig.RiskReward, snapSig.Confidence)

				srv.UpdatePositions(activePaperTrade, paperHistory)
			} else {
				go func() {
					req := buildOrderRequest(snapSig, snapDir, currentSym)
					execCtx, execCancel := context.WithTimeout(context.Background(), 15*time.Second)
					defer execCancel()

					if err := orderExecutor.Execute(execCtx, req); err != nil {
						log.Printf("[main] Order execution failed: %v", err)
						consecutiveLosses++
						if consecutiveLosses >= 3 {
							cooldownUntil      = time.Now().Add(60 * time.Minute)
							consecutiveLosses  = 0
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

	// ── Graceful shutdown ─────────────────────────────────────────────────────
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Printf("[main] Shutdown signal received — closing...")
	cancel()
	srv.Stop()
	time.Sleep(500 * time.Millisecond)
}

// ── EMA proxy veto ────────────────────────────────────────────────────────────
func checkEMATrendVeto(feed *market.Feed, direction string) string {
	state := feed.State()
	if state.Price <= 0 {
		return ""
	}
	lsr := state.LSR
	if lsr < 1e-9 {
		return ""
	}
	if direction == "BUY" && lsr < 0.90 {
		return fmt.Sprintf("EMA-PROXY: BUY signal tapi LSR=%.3f (whale SHORT dominant)", lsr)
	}
	if direction == "SELL" && lsr > 1.10 {
		return fmt.Sprintf("EMA-PROXY: SELL signal tapi LSR=%.3f (whale LONG dominant)", lsr)
	}
	return ""
}

// ── Types & helpers ───────────────────────────────────────────────────────────

type orderExec interface {
	Execute(ctx context.Context, req interface{}) error
	FetchFreeUSDT(ctx context.Context) (float64, error)
}

func buildOrderRequest(sig shm.Signal, dir string, symbol string) interface{} {
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
	sym   := state.Symbol
	if sym == "" {
		sym = cfg.Symbol
	}

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

	pct24h := 0.0
	if state.Price > 0 && state.ATR14 > 0 {
		pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10
	}

	dispEntry, dispTP, dispSL := sig.Entry, sig.TakeProfit, sig.StopLoss
	if sig.Veto || dispEntry == 0 {
		dispEntry, dispTP, dispSL = state.Price, state.Price, state.Price
	}

	// [FIX-RT3] Sertakan mode di advice agar user tahu bot lagi di mode apa
	modeTag := ""
	if cfg.DryRun {
		modeTag = " [DRY RUN]"
	} else {
		modeTag = fmt.Sprintf(" [%s/%s]", strings.ToUpper(cfg.Exchange), strings.ToUpper(cfg.ExchangeMode))
	}

	srv.UpdateInsight(gateway.InsightData{
		Symbol:       sym,
		LastPrice:    state.Price,
		OpenInterest: state.OI,
		LSRVal:       lsr,
		Pct24h:       pct24h,
		TrendState:   trend,
		WhaleBias:    bias,
		SignalStatus: action,
		Advice:       advice + modeTag,
		Timestamp:    time.Now().Format("15:04:05"),
		Balance:      balance,
		EntryTarget:  dispEntry,
		TPTarget:     dispTP,
		SLTarget:     dispSL,
	})
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// maskKey menampilkan 4 karakter pertama + *** untuk log keamanan
func maskKey(key string) string {
	if key == "" {
		return "(empty)"
	}
	if len(key) <= 4 {
		return "****"
	}
	return key[:4] + "****" + key[len(key)-4:]
}

// ── Env helpers ───────────────────────────────────────────────────────────────

// loadEnvFile membaca file dan set env var jika belum ada.
// Dipanggil dua kali: loadEnvFile(".env") lalu loadEnvFile("bot_runtime.conf").
// Karena hanya set jika os.Getenv(k) == "", urutan pemanggilan menentukan prioritas.
func loadEnvFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return // file tidak ada = skip, bukan error
	}
	loaded := 0
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
			loaded++
		}
	}
	if loaded > 0 {
		log.Printf("[main] Loaded %d env vars from %s", loaded, path)
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
		val := strings.ToLower(v)
		return val == "1" || val == "true" || val == "on" || val == "yes"
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
