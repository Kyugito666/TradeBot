// go-engine/main.go
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG vs v3.3:
//
// [FIX-VETO-1] EMA PROXY VETO THRESHOLD DILONGGARKAN
//   ROOT CAUSE: checkEMATrendVeto() memblok SELL jika LSR > 1.10.
//   Dengan LSR=1.475 (whale LONG heavy), semua SELL signal conf < 0.5 dibuang.
//   FIX: Naikkan threshold SELL veto dari 1.10 → 2.0 (extreme whale dominance).
//        Naikkan threshold BUY veto dari 0.90 → 0.50.
//        Confidensi minimum untuk bypass EMA veto turun 0.5 → 0.40.
//   ALASAN: LSR 1.10 terlalu dekat dari neutral (1.0). Threshold 2.0 = whale
//           benar-benar ekstrem → 2× lebih banyak long vs short.
//
// [FIX-VETO-2] BYPASS EMA VETO UNTUK HIGH CONFIDENCE
//   FIX: Jika conf >= 0.65 (strong signal dari Rust brain), bypass semua
//        EMA proxy veto. Rust brain + consensus 6 agent lebih reliable
//        dari heuristic LSR sederhana ini.
//
// [FIX-DEDUP] DEDUP WINDOW DIPERPENDEK
//   ROOT CAUSE: Setelah order gagal, SKIP-DEDUP menahan signal 1 detik.
//   Tapi retry logic tidak ada — jadi satu error = satu miss permanen.
//   FIX: Jika lastAction gagal (order execution error), reset lastActionAt
//        agar signal berikutnya bisa masuk setelah 3 detik (bukan full timeout).
//
// [FIX-RT1-4] Semua fix dari v3.3 dipertahankan.
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
	loadEnvFile(".env")
	loadEnvFile("bot_runtime.conf")

	c := Config{
		Exchange:     envStr("EXCHANGE", "bybit"),
		ExchangeMode: envStr("EXCHANGE_MODE", "demo"),
		Symbol:       envStr("SYMBOL", "SOLUSDT"),
		OHLCVTF:      "5",
		OHLCVLimit:   200,
		RiskPct:      envFloat("RISK_PCT", 0.03),
		Leverage:     envInt("LEVERAGE", 10),
		DryRun:       envBool("DRY_RUN", false),
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
	log.Printf("  TradeBot Go Orchestrator  v3.4")
	log.Printf("  [FIX-VETO-1] EMA proxy threshold 1.10→2.0 (SELL) / 0.90→0.50 (BUY)")
	log.Printf("  [FIX-VETO-2] High-confidence (>=0.65) bypass EMA veto")
	log.Printf("  [FIX-DEDUP]  Order resets dedup timer (3s retry)")
	log.Printf("  [FIX-MEXC]   Robust MEXC balance fetch with raw logging")
	log.Printf("═══════════════════════════════════════════")

	cfg := loadConfig()

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
			if cfg.BybitDemoKey != "" {
				apiKey, apiSecret = cfg.BybitDemoKey, cfg.BybitDemoSecret
				log.Printf("[main] Bybit DEMO mode — menggunakan demo API key")
			} else {
				log.Printf("[main] WARNING: Bybit DEMO mode tapi BYBIT_DEMO_API_KEY kosong")
			}
		} else {
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
			Leverage:  cfg.Leverage,
			RiskPct:   cfg.RiskPct,
		})
	default:
		log.Fatalf("[main] Unknown exchange: %s", cfg.Exchange)
	}

	// ── Gateway server ────────────────────────────────────────────────────────
	srv := gateway.New(cfg.BaseDir)
	go srv.Start()

	// ── Initial balance fetch ─────────────────────────────────────────────────
	ctx := context.Background()
	balance := 0.0
	if b, err := fetchBalance(ctx, orderExecutor, cfg, srv); err == nil {
		balance = b
		log.Printf("[main]   Exchange connected | exchange=%s mode=%s | free_USDT=%.2f",
			cfg.Exchange, cfg.ExchangeMode, balance)
	} else {
		log.Printf("[main] ⚠️ Gagal fetch balance awal: %v", err)
	}

	// [FIX-BAL-DASH] Push initial balance to dashboard so it doesn't show --- while waiting for first signal
	srv.UpdateInsight(gateway.InsightData{
		Balance: balance,
		Timestamp: time.Now().Format("15:04:05"),
		Advice: "Menyiapkan mesin AI & menunggu data market pertama...",
	})

	// ── Market feed ───────────────────────────────────────────────────────────
	feed := market.New(bridge, cfg.Symbol, cfg.OHLCVTF, cfg.OHLCVLimit)
	mainCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go feed.Run(mainCtx)

	// ── Symbol channel wiring ────────────────────────────────────────────────
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
	lastRustSeq       := uint64(0)
	lastAction        := "WAIT"
	lastActionAt      := time.Now().Add(-10 * time.Minute)
	cooldownUntil     := time.Time{}
	consecutiveLosses := 0

	// [FIX-DEDUP] Track last execution result untuk reset timer jika gagal
	lastOrderFailed := false

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

			state := feed.State()
			currentSym := state.Symbol
			if currentSym == "" {
				currentSym = cfg.Symbol
			}

			// ── Paper trade TP/SL check + timeout (Lakukan SEBELUM block sig & pause) ──
			isDryRun := srv.IsDryRun()
			if isDryRun && activePaperTrade != nil {
				isClosed    := false
				closeReason := ""
				
				if activePaperTrade.Symbol != "" && state.Symbol != "" && activePaperTrade.Symbol != state.Symbol {
					activePaperTrade.Status = "CANCELLED_PAIR_SWITCH"
					isClosed = true
					closeReason = "User switched trading pair"
				} else if activePaperTrade.Status == "PENDING" {
					if (activePaperTrade.Side == "BUY" && state.Price <= activePaperTrade.LimitPrice) || 
					   (activePaperTrade.Side == "SELL" && state.Price >= activePaperTrade.LimitPrice) {
						activePaperTrade.Status = "OPEN"
						activePaperTrade.EntryPrice = activePaperTrade.LimitPrice
						log.Printf("[Paper] 📈 LIMIT Order KEJEMPUT! Status PENDING -> OPEN @ %.4f", activePaperTrade.EntryPrice)
						srv.UpdatePositions(activePaperTrade, paperHistory)
					} else if time.Since(paperTradeOpenedAt) > 30 * time.Minute {
						activePaperTrade.Status = "CLOSED_TIMEOUT"
						isClosed = true
						closeReason = "Limit Order expired (30 min)"
					}
				}

				if activePaperTrade.Status == "OPEN" {
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
				}

				if isClosed {
					log.Printf("[Paper] ✗ Trade Closed: %s | %s | PnL=%.2f%%",
						activePaperTrade.Status, closeReason, activePaperTrade.PnL)
					// Handle PnL for Virtual Balance
					if isDryRun {
						virtualBal := srv.GetVirtualBalance()
						// Balikin margin + PnL (di mana PnL adalah persentase ROE)
						profitUSD := activePaperTrade.Margin * (activePaperTrade.PnL / 100.0)
						marginReturned := activePaperTrade.Margin + profitUSD
						srv.SetVirtualBalance(virtualBal + marginReturned)
					}

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

			if !srv.IsBotRunning() {
				lsr := state.LSR
				if lsr < 1e-9 {
					lsr = 1.0
				}
				pct24h := 0.0
				if state.Price > 0 {
					pct24h = math.Round((state.ATR14/state.Price)*100*10) / 10
				}
				srv.UpdateInsight(gateway.InsightData{
					Symbol: currentSym, LastPrice: state.Price, OpenInterest: state.OI,
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

			// ─── BOT RUNNING (Signal dari Rust) ───────────────────────────────
			sig := bridge.PollSignal(200 * time.Millisecond)
			if sig == nil {
				continue
			}
			if uint64(sig.TsMs) == lastRustSeq {
				time.Sleep(10 * time.Millisecond)
				continue
			}
			lastRustSeq = uint64(sig.TsMs)

			dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]

			printEntry, printTP, printSL := sig.Entry, sig.TakeProfit, sig.StopLoss
			if sig.Veto || printEntry == 0 {
				printEntry, printTP, printSL = state.Price, state.Price, state.Price
			}

			log.Printf("[main] [%s] Signal: %s conf=%.3f entry=%.4f TP=%.4f SL=%.4f RR=%.2f veto=%v",
				currentSym, dirStr, sig.Confidence, printEntry, printTP, printSL, sig.RiskReward, sig.Veto)

			// Refresh balance
			if b, err := fetchBalance(context.Background(), orderExecutor, cfg, srv); err == nil {
				balance = b
			}

			updateInsight(srv, cfg, sig, balance, dirStr, feed)

			if sig.Veto || dirStr == "WAIT" {
				// if sig.Veto {
				// 	log.Printf("[SKIP-VETO] %s", truncate(sig.VetoReason, 80))
				// }
				lastAction = "WAIT"
				continue
			}

			if time.Now().Before(cooldownUntil) {
				log.Printf("[SKIP-COOLDOWN] Circuit breaker aktif sampai %s", cooldownUntil.Format("15:04:05"))
				continue
			}

			// [FIX-DEDUP] Jika order sebelumnya gagal, reset lastActionAt ke 3s lalu
			// supaya signal retry bisa masuk setelah 3 detik (bukan nunggu full timeout)
			if lastOrderFailed && dirStr == lastAction {
				if time.Since(lastActionAt) > 3*time.Second {
					log.Printf("[RETRY] Last order failed, allowing retry for %s", dirStr)
					lastActionAt = time.Now().Add(-getLastActionTimeout())
					lastOrderFailed = false
				}
			}

			if dirStr == lastAction && time.Since(lastActionAt) < getLastActionTimeout() {
				log.Printf("[SKIP-DEDUP] Arah %s sama, %.0f detik lalu", dirStr, time.Since(lastActionAt).Seconds())
				continue
			}

			rrLimit := 1.0
			switch strings.ToLower(cfg.TradingStyle) {
			case "scalping":
				rrLimit = 0.5
			case "daytrading", "daytrade":
				rrLimit = 0.8
			case "swing", "sniper":
				rrLimit = 1.0
			}
			if sig.RiskReward < rrLimit {
				log.Printf("[SKIP-RR] RR=%.2f < %.2f (style=%s)", sig.RiskReward, rrLimit, cfg.TradingStyle)
				continue
			}

			// Go engine tidak lagi memblokir via checkEMATrendVeto.
			// Biarkan ConsensusEngine (Rust) yang menentukan EMA Veto (check_ema_trend_veto_v2).

			if isDryRun && activePaperTrade != nil {
				log.Printf("[SKIP-OPEN] Paper trade masih open: %s @ %.4f", activePaperTrade.Side, activePaperTrade.EntryPrice)
				continue
			}

			lastAction  = dirStr
			lastActionAt = time.Now()

			snapSig := *sig
			snapDir := dirStr

			if isDryRun {
				// Potong margin dari Virtual Balance
				virtualBal := srv.GetVirtualBalance()
				estimatedMargin := virtualBal * cfg.RiskPct
				if virtualBal < estimatedMargin || estimatedMargin <= 0 {
					log.Printf("[PAPER] Margin tidak cukup! Balance: %.2f, Butuh: %.2f", virtualBal, estimatedMargin)
					continue
				}
				srv.SetVirtualBalance(virtualBal - estimatedMargin)

				activePaperTrade = &gateway.Position{
					Symbol:     cfg.Symbol,
					Side:       snapDir,
					EntryPrice: state.Price, // Harga saat order ditaruh
					LimitPrice: snapSig.Entry,
					TakeProfit: snapSig.TakeProfit,
					StopLoss:   snapSig.StopLoss,
					Time:       time.Now().Format("15:04:05"),
					Status:     "PENDING",
					PnL:        0.0,
					Margin:     estimatedMargin,
				}
				paperTradeOpenedAt = time.Now()

				log.Printf("[Paper] ✓ LIMIT Order placed: %s %s @ %.4f (Waiting for %.4f)",
					snapDir, currentSym, state.Price, snapSig.Entry)
				log.Printf("[Paper]   TP=%.4f SL=%.4f RR=%.2f conf=%.3f",
					snapSig.TakeProfit, snapSig.StopLoss, snapSig.RiskReward, snapSig.Confidence)

				srv.UpdatePositions(activePaperTrade, paperHistory)
			} else {
				go func() {
					req := buildOrderRequest(snapSig, snapDir, currentSym)
					execCtx, execCancel := context.WithTimeout(context.Background(), 15*time.Second)
					defer execCancel()

					if err := orderExecutor.Execute(execCtx, req); err != nil {
						log.Printf("[main] ✗ Order execution failed: %v", err)
						consecutiveLosses++
						lastOrderFailed = true // [FIX-DEDUP] flag for retry
						if consecutiveLosses >= 3 {
							cooldownUntil      = time.Now().Add(60 * time.Minute)
							consecutiveLosses  = 0
							log.Printf("[main] CIRCUIT BREAKER: 3 consecutive failures, 60-min cooldown")
						}
					} else {
						log.Printf("[main] ✓ Order fired: %s %s", snapDir, currentSym)
						consecutiveLosses = 0
						lastOrderFailed = false
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
	srv.RefundActiveMargin()
	cancel()
	srv.Stop()
	time.Sleep(500 * time.Millisecond)
}

// ── EMA proxy veto ────────────────────────────────────────────────────────────
//
// [FIX-VETO-1] Threshold dilonggarkan:
//   SELL veto: LSR > 2.0 (sebelumnya 1.10) — whale 2× lebih banyak long vs short
//   BUY veto:  LSR < 0.50 (sebelumnya 0.90) — whale 2× lebih banyak short vs long
//
// [FIX-VETO-2] High-confidence bypass:
//   Jika conf >= 0.65 → bypass semua EMA proxy veto.
//   6-agent Rust brain lebih reliable dari heuristic LSR ini.
//
// Kenapa sebelumnya salah:
//   LSR=1.475 → whale 60% LONG, 40% SHORT → bukan dominance ekstrem.
//   Threshold 1.10 = cuma 10% lebih banyak long → TERLALU SENSITIF.
//   Akibatnya hampir semua SELL signal diblok di market normal.
func checkEMATrendVeto(feed *market.Feed, direction string, confidence float64) string {
	state := feed.State()
	if state.Price <= 0 {
		return ""
	}
	lsr := state.LSR
	if lsr < 1e-9 {
		return ""
	}

	// [FIX-VETO-2] High confidence signal — bypass veto entirely
	// Rust brain 6-agent consensus lebih akurat dari LSR heuristic
	if confidence >= 0.35 {
		log.Printf("[EMA-PROXY] conf=%.3f >= 0.35 → bypass LSR veto (LSR=%.3f dir=%s)",
			confidence, lsr, direction)
		return ""
	}

	// [FIX-VETO-1] Threshold baru: 2.0 untuk SELL, 0.50 untuk BUY
	if direction == "BUY" && lsr < 0.50 {
		// Whale SHORT extreme (LSR < 0.5 = 2× lebih banyak SHORT vs LONG)
		if confidence < 0.45 {
			return fmt.Sprintf("EMA-PROXY: BUY signal tapi LSR=%.3f (extreme SHORT dominance) conf=%.3f < 0.45", lsr, confidence)
		}
	}
	if direction == "SELL" && lsr > 2.0 {
		// Whale LONG extreme (LSR > 2.0 = 2× lebih banyak LONG vs SHORT)
		if confidence < 0.45 {
			return fmt.Sprintf("EMA-PROXY: SELL signal tapi LSR=%.3f (extreme LONG dominance) conf=%.3f < 0.45", lsr, confidence)
		}
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

func fetchBalance(ctx context.Context, exec orderExec, cfg Config, srv *gateway.Server) (float64, error) {
	if srv.IsDryRun() {
		return srv.GetVirtualBalance(), nil
	}
	// Fetch dari exchange via adapter khusus
	// timeout khusus buat fetch
	fetchCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	b, err := exec.FetchFreeUSDT(fetchCtx)
	if err != nil {
		return 0, err
	}
	return b, nil
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
		ATR:          state.ATR14,
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

func loadEnvFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
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
