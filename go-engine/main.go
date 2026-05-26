// go-engine/main.go
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
			log.Printf("[main] Balance: %.2f USDT", balance)
		} else {
			log.Printf("[main] API Auth Error: %v", err)
		}
	} else {
		balance = 10000.0
		log.Printf("[main] DRY RUN — simulated balance %.2f USDT", balance)
	}

	srv := gateway.New(cfg.BaseDir)
	go srv.Start()

	feed := market.New(bridge, cfg.Symbol, cfg.OHLCVTF, cfg.OHLCVLimit)
	mainCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go feed.Run(mainCtx)

	nlpEngine := nlp.NewEngine(cfg.Symbol, 5*time.Minute)
	go nlpEngine.Run(mainCtx, feed)

	lastRustSeq := uint64(0)
	lastAction := "WAIT"
	cooldownUntil := time.Time{}
	consecutiveLosses := 0

	// Variabel In-Memory untuk simulasi Paper Trading
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
			if sig.TsMs == int64(lastRustSeq) { time.Sleep(10 * time.Millisecond); continue }
			lastRustSeq = uint64(sig.TsMs)

			state := feed.State()

			// ── [1] MANAJER PAPER TRADING (PNL LIVE & TP/SL) ──
			if cfg.DryRun && activePaperTrade != nil {
				isClosed := false
				
				// Kalkulasi Live PnL dengan Leverage
				unrealizedPct := 0.0
				if activePaperTrade.Side == "BUY" {
					unrealizedPct = ((state.Price - activePaperTrade.EntryPrice) / activePaperTrade.EntryPrice) * 100.0
				} else if activePaperTrade.Side == "SELL" {
					unrealizedPct = ((activePaperTrade.EntryPrice - state.Price) / activePaperTrade.EntryPrice) * 100.0
				}
				activePaperTrade.PnL = unrealizedPct * float64(cfg.Leverage)

				// Hitung persentase sentuhan TP / SL
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
					log.Printf("[Paper] Trade Closed: %s PnL: %.2f%%", activePaperTrade.Status, activePaperTrade.PnL)
					paperHistory = append([]gateway.Position{*activePaperTrade}, paperHistory...) // Simpan ke histori (unshift)
					if len(paperHistory) > 50 {
						paperHistory = paperHistory[:50] // Batasi 50 row agar ringan
					}
					activePaperTrade = nil
				}
				
				// Push status ke UI
				srv.UpdatePositions(activePaperTrade, paperHistory)
			}

			// ── [2] LOGIKA SINYAL BIASA ──
			dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]
			if !srv.IsBotRunning() { dirStr = "WAIT" }

			// FIX: Biar terminal lu ga nampilin angka 0.0000 pas VETO dan bikin lu panik, kita timpa khusus buat display log.
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

			if time.Now().Before(cooldownUntil) { continue }
			if dirStr == lastAction { continue }

			// Adaptasi limit RR berdasarkan style di .env
			rrLimit := 1.2
			switch strings.ToLower(cfg.TradingStyle) {
			case "scalping": rrLimit = 0.8
			case "daytrading": rrLimit = 1.0
			case "swing": rrLimit = 1.5
			}

			if sig.RiskReward < rrLimit {
				log.Printf("[main] RR %.2f < %.2f (%s) — skipping low-quality signal", sig.RiskReward, rrLimit, cfg.TradingStyle)
				continue
			}

			lastAction = dirStr
			snapSig := *sig
			snapDir := dirStr
			
			// ── [3] EKSEKUSI (REAL VS PAPER) ──
			if cfg.DryRun {
				// Cegah nembak order baru kalo Paper Trade lama masih kebuka
				if activePaperTrade == nil {
					activePaperTrade = &gateway.Position{
						Side:       snapDir,
						EntryPrice: state.Price, // Ambil harga market real saat ini
						TakeProfit: snapSig.TakeProfit,
						StopLoss:   snapSig.StopLoss,
						Time:       time.Now().Format("15:04:05"),
						Status:     "OPEN",
						PnL:        0.0,
					}
					log.Printf("[Paper] ✓ Virtual Order opened: %s %s @ %.4f", snapDir, cfg.Symbol, state.Price)
					srv.UpdatePositions(activePaperTrade, paperHistory)
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

	// Override display bila VETO atau nol
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

// FIX: Parser bool robust untuk nangani string "on" dari input UI
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
