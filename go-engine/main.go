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
	"bytes"

	"context"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
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
		Symbol:       envStr("SYMBOL", "BTCUSDT"),
		OHLCVTF:      "5",
		OHLCVLimit:   1000,
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

	// BaseDir: where bot_runtime.conf, virtual_balance.txt, etc. are stored.
	// Prioritize BOT_BASE_DIR env var (set by start_bot.sh → D:\database\engine)
	if envBase := os.Getenv("BOT_BASE_DIR"); envBase != "" {
		c.BaseDir = envBase
	} else if pwd, err := os.Getwd(); err == nil {
		if filepath.Base(pwd) == "go-engine" {
			c.BaseDir = filepath.Dir(pwd)
		} else {
			c.BaseDir = pwd
		}
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
	// Seed default config into bot_runtime.conf so settings persist across restarts
	srv.SeedDefaults(cfg.Symbol, cfg.ExchangeMode, cfg.TradingStyle, cfg.Leverage, cfg.DryRun)
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

	// ── Context ───────────────────────────────────────────────────────────────
	mainCtx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// ── NLP engine ───────────────────────────────────────────────────────────
	nlpEngine := nlp.NewEngine(cfg.Symbol, 5*time.Minute)
	// (Note: nlpEngine.Run will now be started after activeFeeds is populated)

	activePaperTrades := make(map[string]*gateway.Position)
	paperTradeOpenedAts := make(map[string]time.Time)
	var paperHistory []gateway.Position

	type PaperTradesState struct {
		Active   map[string]*gateway.Position `json:"active"`
		History  []gateway.Position           `json:"history"`
		OpenedAt map[string]time.Time         `json:"opened_at"`
	}

	dbDir := os.Getenv("BOT_DB_DIR")
	if dbDir == "" {
		dbDir = "/mnt/d/database"
	}
	engineDir := filepath.Join(dbDir, "engine")
	os.MkdirAll(engineDir, 0755)
	
	stateFile := filepath.Join(engineDir, "paper_trades.bin")
	if _, err := os.Stat(stateFile); os.IsNotExist(err) {
		os.WriteFile(stateFile, []byte{}, 0644)
	}
	if f, err := os.Open(stateFile); err == nil {
		var state PaperTradesState
		if err := gob.NewDecoder(f).Decode(&state); err == nil {
			if state.Active != nil {
				activePaperTrades = state.Active
			}
			paperHistory = state.History
			if state.OpenedAt != nil {
				paperTradeOpenedAts = state.OpenedAt
			}
			log.Printf("[Paper] Hydrated persistent state: actives=%d history_len=%d", len(activePaperTrades), len(paperHistory))
			var actives []gateway.Position
			for _, v := range activePaperTrades {
				if v != nil { actives = append(actives, *v) }
			}
			srv.UpdatePositions(actives, paperHistory)
		}
		f.Close()
	}

	savePaperState := func() {
		state := PaperTradesState{
			Active:   activePaperTrades,
			History:  paperHistory,
			OpenedAt: paperTradeOpenedAts,
		}
		if f, err := os.Create(stateFile); err == nil {
			gob.NewEncoder(f).Encode(state)
			f.Close()
		}
	}

	// ── Auto Screener & Feeds ───────────────────────────────────────────────
	activeFeeds := make(map[string]*market.Feed)
	
	// Default starting feed
	initialFeed := market.New(cfg.Symbol, cfg.OHLCVTF, cfg.OHLCVLimit, nil)
	activeFeeds[cfg.Symbol] = initialFeed
	
	go func() {
		initialFeed.Run(mainCtx)
	}()
	go nlpEngine.Run(mainCtx, initialFeed)

	go func() {
		log.Printf("[Screener] Started. Will fetch top volatile pairs every 5 minutes (first scan in 10s).")
		// Trigger first scan quickly so we don't stay locked on single symbol
		time.Sleep(10 * time.Second)
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		
		scanNow := make(chan struct{}, 1)
		scanNow <- struct{}{} // Trigger immediate first scan
		
		for {
			select {
			case <-mainCtx.Done():
				return
			case <-scanNow:
				if srv.IsBacktesting() { continue }
			case <-ticker.C:
				if srv.IsBacktesting() { continue }
				
				// 1. Fetch Bybit Tickers
				resp, err := http.Get("https://api.bytick.com/v5/market/tickers?category=linear")
				if err != nil {
					log.Printf("[Screener] Error fetching tickers: %v", err)
					continue
				}
				
				var res struct {
					Result struct {
						List []struct {
							Symbol        string `json:"symbol"`
							Turnover24h   string `json:"turnover24h"`
							Price24hPcnt  string `json:"price24hPcnt"`
						} `json:"list"`
					} `json:"result"`
				}
				if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
					resp.Body.Close()
					continue
				}
				resp.Body.Close()
				
				// 2. Filter & Sort
				type PairData struct {
					Symbol string
					Vol    float64
					Pcnt   float64
				}
				var validPairs []PairData
				for _, p := range res.Result.List {
					if strings.Contains(p.Symbol, "-") { continue }
					if !strings.HasSuffix(p.Symbol, "USDT") { continue }
					
					vol, _ := strconv.ParseFloat(p.Turnover24h, 64)
					pcnt, _ := strconv.ParseFloat(p.Price24hPcnt, 64)
					validPairs = append(validPairs, PairData{Symbol: p.Symbol, Vol: vol, Pcnt: math.Abs(pcnt)})
				}
				
				sort.Slice(validPairs, func(i, j int) bool {
					return validPairs[i].Pcnt > validPairs[j].Pcnt // sort by highest volatility
				})
				
				// ── [Fase 8B] BigData Multi-Symbol Pipeline ──────────────────────
				// Cap at top 50 most volatile USDT pairs to prevent goroutine flood
				const maxBigDataFeeds = 50
				
				targetFeeds := make(map[string]bool)
				
				activeUiSym := srv.GetActiveSymbol()
				if activeUiSym == "" { activeUiSym = cfg.Symbol }
				targetFeeds[activeUiSym] = true // Always keep primary symbol
				
				added := 0
				for _, vp := range validPairs {
					if added >= maxBigDataFeeds - 1 { break } // -1 for primary
					if vp.Symbol != activeUiSym && vp.Vol > 1_000_000 { // Min $1M turnover
						targetFeeds[vp.Symbol] = true
						added++
					}
				}
				
				log.Printf("[Screener] BigData tracking %d symbols (top volatile, >$1M vol)", len(targetFeeds))
				
				// Reconcile activeFeeds — remove dead, add new
				for sym := range activeFeeds {
					if !targetFeeds[sym] {
						log.Printf("[Screener] Removing feed for %s", sym)
						delete(activeFeeds, sym)
					}
				}
				
				for sym := range targetFeeds {
					if _, ok := activeFeeds[sym]; !ok {
						newFeed := market.New(sym, cfg.OHLCVTF, cfg.OHLCVLimit, nil)
						activeFeeds[sym] = newFeed
						go newFeed.Run(mainCtx)
					}
				}
				
				log.Printf("[Screener] Active feeds: %d", len(activeFeeds))
			}
		}
	}()

	// ── [Fase 8B] BigData Tick Stats Logger ──────────────────────────────────
	go func() {
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-mainCtx.Done():
				return
			case <-ticker.C:
				log.Printf("[BigData] Active feeds: %d symbols streaming", len(activeFeeds))
			}
		}
	}()

	// ── Main signal loop (Round-Robin Multi-Symbol) ──────────────────────────
	go func() {
		log.Printf("[main] Signal poll loop started (round-robin multi-symbol)")
		log.Printf("[main] ⚠ Bot STOPPED — menunggu START dari dashboard")

		// [Fase 8B] Round-robin index for fair SHM scheduling
		rrIndex := 0

		for {
			select {
			case <-mainCtx.Done():
				return
			default:
			}

			if srv.IsBacktesting() {
				time.Sleep(1 * time.Second)
				continue
			}

			activeUiSym := srv.GetActiveSymbol()
			if activeUiSym == "" { activeUiSym = cfg.Symbol }

			isDryRun := srv.IsDryRun()
			botRunning := srv.IsBotRunning()

			// [Fase 8B] Build ordered symbol list for round-robin
			symList := make([]string, 0, len(activeFeeds))
			// Primary symbol ALWAYS first
			if _, ok := activeFeeds[activeUiSym]; ok {
				symList = append(symList, activeUiSym)
			}
			for sym := range activeFeeds {
				if sym != activeUiSym {
					symList = append(symList, sym)
				}
			}

			if len(symList) == 0 {
				time.Sleep(500 * time.Millisecond)
				continue
			}

			// [Fase 8B] Process primary symbol EVERY cycle + one secondary via round-robin
			processSyms := []string{}
			if len(symList) > 0 {
				processSyms = append(processSyms, symList[0]) // primary always
			}
			if len(symList) > 1 {
				rrIndex = ((rrIndex) % (len(symList) - 1)) + 1 // rotate through secondary symbols
				if rrIndex < len(symList) {
					processSyms = append(processSyms, symList[rrIndex])
				}
				rrIndex++
			}

			for _, currentSym := range processSyms {
				feed := activeFeeds[currentSym]
				if feed == nil { continue }
				md := feed.GetMarketData(currentSym)
				if md == nil || md.Price <= 0 || len(md.Candles) == 0 {
					continue
				}

				activePaperTrade := activePaperTrades[currentSym]
				paperTradeOpenedAt := paperTradeOpenedAts[currentSym]
				
				if isDryRun && activePaperTrade != nil {
					isClosed    := false
					closeReason := ""
					
					if activePaperTrade.Status == "PENDING" {
						if (activePaperTrade.Side == "BUY" && md.Price <= activePaperTrade.LimitPrice) || 
						   (activePaperTrade.Side == "SELL" && md.Price >= activePaperTrade.LimitPrice) {
							activePaperTrade.Status = "OPEN"
							activePaperTrade.EntryPrice = activePaperTrade.LimitPrice
							log.Printf("[Paper] 📈 LIMIT Order KEJEMPUT! Status PENDING -> OPEN @ %.4f", activePaperTrade.EntryPrice)
							
							var actives []gateway.Position
							for _, v := range activePaperTrades {
								if v != nil { actives = append(actives, *v) }
							}
							srv.UpdatePositions(actives, paperHistory)
							savePaperState()
						} else if time.Since(paperTradeOpenedAt) > 30 * time.Minute {
							activePaperTrade.Status = "CLOSED_TIMEOUT"
							isClosed = true
							closeReason = "Limit Order expired (30 min)"
						}
					}

					if activePaperTrade.Status == "OPEN" {
						unrealizedPct := 0.0
						if activePaperTrade.Side == "BUY" {
							unrealizedPct = ((md.Price - activePaperTrade.EntryPrice) / activePaperTrade.EntryPrice) * 100.0
						} else if activePaperTrade.Side == "SELL" {
							unrealizedPct = ((activePaperTrade.EntryPrice - md.Price) / activePaperTrade.EntryPrice) * 100.0
						}
						
						feeImpactPct := float64(cfg.Leverage) * 0.11 
						activePaperTrade.PnL = (unrealizedPct * float64(cfg.Leverage)) - feeImpactPct

						// Cap PnL at -100% (Liquidation)
						if activePaperTrade.PnL <= -100.0 {
							activePaperTrade.PnL = -100.0
							activePaperTrade.Status = "LIQUIDATED"
							isClosed    = true
							closeReason = fmt.Sprintf("LIQUIDATED @ %.4f", md.Price)
						} else if (activePaperTrade.Side == "BUY" && md.Price >= activePaperTrade.TakeProfit) ||
							(activePaperTrade.Side == "SELL" && md.Price <= activePaperTrade.TakeProfit) {
							activePaperTrade.Status = "CLOSED_TP"
							isClosed    = true
							closeReason = fmt.Sprintf("TP hit @ %.4f (target=%.4f)", md.Price, activePaperTrade.TakeProfit)
						} else if (activePaperTrade.Side == "BUY" && md.Price <= activePaperTrade.StopLoss) ||
							(activePaperTrade.Side == "SELL" && md.Price >= activePaperTrade.StopLoss) {
							activePaperTrade.Status = "CLOSED_SL"
							isClosed    = true
							closeReason = fmt.Sprintf("SL hit @ %.4f (target=%.4f)", md.Price, activePaperTrade.StopLoss)
						}

						if !isClosed && time.Since(paperTradeOpenedAt) > 48 * time.Hour {
							activePaperTrade.Status = "TIMEOUT"
							isClosed    = true
							closeReason = fmt.Sprintf("TIMEOUT, price=%.4f", md.Price)
						}
					}

					if isClosed {
						log.Printf("[Paper][%s] ✗ Trade Closed: %s | %s | PnL=%.2f%%", currentSym,
							activePaperTrade.Status, closeReason, activePaperTrade.PnL)
						if isDryRun {
							virtualBal := srv.GetVirtualBalance()
							profitUSD := activePaperTrade.Margin * (activePaperTrade.PnL / 100.0)
							marginReturned := activePaperTrade.Margin + profitUSD
							newBal := virtualBal + marginReturned
							if newBal < 0 {
								newBal = 0 // Margin Call / Anti-minus safeguard
							}
							srv.SetVirtualBalance(newBal)
						}

						go func(t gateway.Position, closedPrice float64, isWin bool, ts int64) {
							payload := map[string]interface{}{
								"open_ts": ts,
								"close_ts": time.Now().UnixMilli(),
								"symbol": t.Symbol,
								"direction": t.Side,
								"entry": t.EntryPrice,
								"tp": t.TakeProfit,
								"sl": t.StopLoss,
								"close_price": closedPrice,
								"is_win": isWin,
								"rr": t.PnL,
								"is_real_money": !isDryRun,
								"is_shadow": false,
							}
							if b, err := json.Marshal(payload); err == nil {
								http.Post("http://127.0.0.1:8080/api/save_trade", "application/json", bytes.NewBuffer(b))
							}
						}(*activePaperTrade, md.Price, activePaperTrade.Status == "CLOSED_TP", paperTradeOpenedAt.UnixMilli())


						paperHistory = append([]gateway.Position{*activePaperTrade}, paperHistory...)
						if len(paperHistory) > 5000 {
							paperHistory = paperHistory[:5000]
						}
						delete(activePaperTrades, currentSym)
						delete(paperTradeOpenedAts, currentSym)
						activePaperTrade = nil
						savePaperState()
					}

					var actives []gateway.Position
					for _, v := range activePaperTrades {
						if v != nil { actives = append(actives, *v) }
					}
					srv.UpdatePositions(actives, paperHistory)
				}

				bridge.WriteMarket(md)
				
				sig := bridge.PollSignal(50 * time.Millisecond)
				if sig == nil {
					continue
				}

				dirStr := []string{"WAIT", "BUY", "SELL"}[sig.Action]
				
				printEntry, printTP, printSL := sig.Entry, sig.TakeProfit, sig.StopLoss
				if sig.Veto || printEntry == 0 {
					printEntry, printTP, printSL = md.Price, md.Price, md.Price
				}
				
				if dirStr != "WAIT" {
					log.Printf("[main][%s] Signal: %s conf=%.3f entry=%.4f TP=%.4f SL=%.4f RR=%.2f veto=%v",
						currentSym, dirStr, sig.Confidence, printEntry, printTP, printSL, sig.RiskReward, sig.Veto)
				}
				
				if !botRunning {
					if currentSym == activeUiSym {
						lsr := md.LSR
						if lsr < 1e-9 { lsr = 1.0 }
						pct24h := md.USDTDeltaPct
						
						srv.UpdateInsight(gateway.InsightData{
							Symbol: currentSym, LastPrice: md.Price, OpenInterest: md.OI,
							LSRVal: lsr, Pct24h: pct24h,
							TrendState:   "MANUAL STOPPED — IDLE",
							WhaleBias:    "NEUTRAL",
							SignalStatus: "WAIT",
							Advice:       "Bot Paused",
							Timestamp:    time.Now().Format("15:04:05"),
							Balance:      balance,
							EntryTarget:  printEntry,
							TPTarget:     printTP,
							SLTarget:     printSL,
						})
					}
					continue
				}
				
				if dirStr != "WAIT" && md.ATR14 > 0 {
					tpMult := 2.0
					slMult := 1.5
					
					switch strings.ToLower(cfg.TradingStyle) {
					case "scalping":
						tpMult = 1.0; slMult = 0.8
					case "hft":
						tpMult = 0.5; slMult = 0.3
					case "daytrading", "daytrade":
						tpMult = 2.0; slMult = 1.0
					case "swing", "sniper":
						tpMult = 5.0; slMult = 2.5
					case "position":
						tpMult = 10.0; slMult = 5.0
					case "turtle":
						tpMult = 15.0; slMult = 8.0
					}
					
					if dirStr == "BUY" {
						sig.StopLoss = sig.Entry - (md.ATR14 * slMult)
						sig.TakeProfit = sig.Entry + (md.ATR14 * tpMult)
					} else if dirStr == "SELL" {
						sig.StopLoss = sig.Entry + (md.ATR14 * slMult)
						sig.TakeProfit = sig.Entry - (md.ATR14 * tpMult)
					}
					
					risk := math.Abs(sig.Entry - sig.StopLoss)
					reward := math.Abs(sig.TakeProfit - sig.Entry)
					if risk > 0 {
						sig.RiskReward = reward / risk
					}
					
					printEntry, printTP, printSL = sig.Entry, sig.TakeProfit, sig.StopLoss
					
				}

				if currentSym == activeUiSym {
					// We need to bypass updateInsight since it takes 'feed', which we removed bridge from.
					// We can just inline UpdateInsight here for dashboard
					lsr := md.LSR
					if lsr < 1e-9 { lsr = 1.0 }
					pct24h := md.USDTDeltaPct
					srv.UpdateInsight(gateway.InsightData{
						Symbol: currentSym, LastPrice: md.Price, OpenInterest: md.OI,
						LSRVal: lsr, Pct24h: pct24h,
						TrendState:   "ACTIVE", WhaleBias: "NEUTRAL", SignalStatus: dirStr,
						Advice: "Tracking " + currentSym, Timestamp: time.Now().Format("15:04:05"),
						Balance: balance, EntryTarget: sig.Entry, TPTarget: sig.TakeProfit, SLTarget: sig.StopLoss,
					})
				}

				if sig.Veto || dirStr == "WAIT" {
					continue
				}
				
				rrLimit := 1.0
				if md.ATR14 > (md.Price * 0.05) { rrLimit -= 0.2 }
				if md.ATR14 < (md.Price * 0.01) { rrLimit += 0.2 }
				if sig.RiskReward < rrLimit { continue }

				if isDryRun && activePaperTrades[currentSym] != nil {
					continue 
				}

				if isDryRun {
					virtualBal := srv.GetVirtualBalance()
					
					// 1. Ambil jatah Margin Usage dari settingan UI (contoh 100% -> cfg.RiskPct = 1.0)
					poolSize := virtualBal * cfg.RiskPct
					
					// 2. Ambil persenan compounding dinamis dari AI Treasury Manager
					allocPct := sig.AllocationPct
					if allocPct <= 0 || allocPct > 1.0 { 
						allocPct = 0.05 // fallback aman 5%
					}

					// 3. Pecah Margin dari jatah pool sesuai saran AI
					estimatedMargin := poolSize * allocPct
					estimatedMargin = math.Round(estimatedMargin*100) / 100 // Round to 2 decimal places to avoid 0.0
					
					// Jika hasil perhitungan terlalu kecil, tetapkan batas bawah aman (misal $0.1) agar tidak nyangkut static atau ter-skip
					if estimatedMargin > 0 && estimatedMargin < 0.1 {
						estimatedMargin = 0.1
					}

					if virtualBal < estimatedMargin || estimatedMargin <= 0 {
						continue
					}
					srv.SetVirtualBalance(virtualBal - estimatedMargin)

					newTrade := &gateway.Position{
						Symbol:     currentSym,
						Side:       dirStr,
						EntryPrice: md.Price,
						LimitPrice: sig.Entry,
						TakeProfit: sig.TakeProfit,
						StopLoss:   sig.StopLoss,
						Time:       time.Now().Format("15:04:05"),
						Status:     "PENDING",
						PnL:        0.0,
						Margin:     estimatedMargin,
					}
					activePaperTrades[currentSym] = newTrade
					paperTradeOpenedAts[currentSym] = time.Now()

					log.Printf("[Paper][%s] ✓ LIMIT Order placed: %s @ %.4f TP=%.4f SL=%.4f Margin=$%.2f (Alloc: %.1f%%)",
						currentSym, dirStr, md.Price, sig.TakeProfit, sig.StopLoss, estimatedMargin, allocPct*100)

					var actives []gateway.Position
					for _, v := range activePaperTrades {
						if v != nil { actives = append(actives, *v) }
					}
					srv.UpdatePositions(actives, paperHistory)
					savePaperState()
				}
			} 
			
			time.Sleep(200 * time.Millisecond)
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

	pct24h := state.Pct24h
	if pct24h == 0 && state.Price > 0 && state.ATR14 > 0 {
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
