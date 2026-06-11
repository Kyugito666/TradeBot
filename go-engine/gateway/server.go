// go-engine/gateway/server.go
// ═══════════════════════════════════════════════════════════════════════════════
// CHANGELOG:
//
// [FIX-S1] DYNAMIC SYMBOL — handleStart baca SYMBOL dari request body.
// [FIX-S2] ENV FILE HANYA SIMPAN API KEYS.
// [FIX-S3] handleGetEnv merge .env (API keys only) + in-memory activeCfg.
// [FIX-S4] writeRuntimeConfig — tulis bot_runtime.conf tiap activeCfg update.
// [FIX-START-ALWAYS] Selalu emit symbol ke symbolCh setiap kali START ditekan.
// [FIX-SYMBOL-LIVE] Emit symbolCh dari handleSaveEnv saat SYMBOL berubah.
//
// [FIX-CLEAN-ENV] ← BARU — ROOT CAUSE FIX settings tidak berubah (#1,#3,#4)
//   BUG LAMA:
//     .env lama (dari template atau install awal) masih berisi EXCHANGE_MODE,
//     DRY_RUN, LEVERAGE, SYMBOL, dll. main.go loadEnvFile() baca .env DULU,
//     jadi env var sudah ter-set. Ketika loadEnvFile("bot_runtime.conf") jalan,
//     semua key sudah ada → di-SKIP total (first-set-wins semantic).
//     Akibat: user ganti Exchange Mode/DryRun/Leverage di dashboard → disave ke
//     bot_runtime.conf → tapi TIDAK PERNAH terbaca karena .env lama menang.
//   FIX:
//     sanitizeEnvFile() dipanggil di New() saat server init. Fungsi ini hapus
//     semua non-API-key entry dari .env, jadi bot_runtime.conf bisa override.
//     Idempotent: kalau .env sudah bersih, tidak ada operasi tulis.
// ═══════════════════════════════════════════════════════════════════════════════
package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	Port              = 8765
	MaxLogLines       = 500
)

var (
	LogFile           = "bot.log"
	InsightFile       = "bot_insight.json"
	EnvFile           = ".env"
	RuntimeConfigFile = "bot_runtime.conf"
)

// [FIX-S2] HANYA key-key ini yang ditulis ke file .env di disk.
var apiKeyNames = map[string]bool{
	"BYBIT_API_KEY":         true,
	"BYBIT_API_SECRET":      true,
	"BYBIT_REAL_API_KEY":    true,
	"BYBIT_REAL_API_SECRET": true,
	"BYBIT_DEMO_API_KEY":    true,
	"BYBIT_DEMO_API_SECRET": true,
	"MEXC_API_KEY":          true,
	"MEXC_API_SECRET":       true,
	"BOT_DB_PATH":           true,
}

type InsightData struct {
	Symbol       string  `json:"symbol"`
	LastPrice    float64 `json:"last_price"`
	OpenInterest float64 `json:"open_interest"`
	LSRVal       float64 `json:"lsr_val"`
	Pct24h       float64 `json:"pct_24h"`
	ATR          float64 `json:"atr"`
	TrendState   string  `json:"trend_state"`
	WhaleBias    string  `json:"whale_bias"`
	SignalStatus string  `json:"signal_status"`
	Advice       string  `json:"advice"`
	Timestamp    string  `json:"timestamp"`
	Balance      float64 `json:"balance"`
	EntryTarget  float64 `json:"entry_target"`
	TPTarget     float64 `json:"tp_target"`
	SLTarget     float64 `json:"sl_target"`
}

type LogLine struct {
	Ts    string `json:"ts"`
	Level string `json:"level"`
	Name  string `json:"name"`
	Msg   string `json:"msg"`
}

type Position struct {
	Symbol     string  `json:"symbol"`
	Side       string  `json:"side"`
	EntryPrice float64 `json:"entry_price"`
	LimitPrice float64 `json:"limit_price,omitempty"`
	TakeProfit float64 `json:"take_profit"`
	StopLoss   float64 `json:"stop_loss"`
	Time       string  `json:"time"`
	Status     string  `json:"status"`
	PnL        float64 `json:"pnl"`
	Margin     float64 `json:"margin"`
}

type Server struct {
	mu         sync.RWMutex
	insight    InsightData
	running    atomic.Bool
	botRunning atomic.Bool
	stop       chan struct{}
	baseDir    string

	activePosList []Position
	history       []Position

	symbolCh      chan string
	BacktestReqCh chan BacktestReq
	cfgMux        sync.RWMutex
	activeCfg     map[string]string

	// Virtual Balance for Dry Run
	virtualBalMux sync.RWMutex
	virtualBal    float64
	lastInitBal   float64 // Used to detect manual balance edits for hard reset

	uiSettings []byte
	styleMgr   *StyleAgentManager

	forceExec     atomic.Bool
	isBacktesting atomic.Bool
}

func (s *Server) SetBacktesting(v bool) {
	s.isBacktesting.Store(v)
}

func (s *Server) IsBacktesting() bool {
	return s.isBacktesting.Load()
}

type BacktestReq struct {
	Period int `json:"period"`
	Speed  int `json:"speed"`
}

func New(baseDir string) *Server {
	if customLog := os.Getenv("BOT_LOG_PATH"); customLog != "" {
		LogFile = customLog
	}

	s := &Server{
		stop:          make(chan struct{}),
		baseDir:       baseDir,
		insight:       InsightData{SignalStatus: "WAIT", TrendState: "RANGING"},
		history:       make([]Position, 0),
		symbolCh:      make(chan string, 100),
		BacktestReqCh: make(chan BacktestReq, 10),
		activeCfg:     make(map[string]string),
	}
	s.botRunning.Store(false)

	// Load uiSettings from bin file if exists
	dbDir := ""
	if p := os.Getenv("BOT_DB_PATH"); p != "" {
		dbDir = filepath.Dir(p)
	}
	if dbDir != "" {
		uiSettingsPath := filepath.Join(dbDir, "config", "ui_settings.bin")
		if b, err := os.ReadFile(uiSettingsPath); err == nil {
			s.uiSettings = b
		}
	}

	if b, err := os.ReadFile(filepath.Join(baseDir, "virtual_balance.txt")); err == nil {
		if val, err := strconv.ParseFloat(string(b), 64); err == nil {
			s.virtualBal = val
		}
	}

	// ═══════════════════════════════════════════════════════════════════════
	// [FIX-CLEAN-ENV] Bersihkan .env dari non-API-key settings SEBELUM seed activeCfg.
	//
	// KENAPA INI CRITICAL:
	//   main.go loadEnvFile() first-set-wins. Jika .env punya EXCHANGE_MODE=demo
	//   (dari template .env.example atau install lama), env var itu ter-set duluan.
	//   Ketika loadEnvFile("bot_runtime.conf") jalan, EXCHANGE_MODE sudah ada →
	//   di-SKIP → semua perubahan dari dashboard diabaikan total.
	//
	//   sanitizeEnvFile() hapus EXCHANGE_MODE, DRY_RUN, LEVERAGE, SYMBOL, dll dari
	//   .env, sehingga bot_runtime.conf bisa properly override di restart berikutnya.
	// ═══════════════════════════════════════════════════════════════════════
	s.sanitizeEnvFile(filepath.Join(baseDir, EnvFile))

	// [FIX-S4] Seed activeCfg dari .env — hanya non-API-key fields
	// Seed dari bot_runtime.conf jika ada (override .env seeds)
	runtime := parseEnvFile(filepath.Join(baseDir, RuntimeConfigFile))
	for k, v := range runtime {
		if !apiKeyNames[k] && v != "" {
			s.activeCfg[k] = v
		}
	}

	s.writeRuntimeConfigLocked()
	s.styleMgr = NewStyleAgentManager(s)
	return s
}

// ── [FIX-CLEAN-ENV] sanitizeEnvFile ─────────────────────────────────────────

// sanitizeEnvFile menghapus non-API-key settings dari .env file.
// Idempotent: jika .env sudah bersih (hanya berisi API keys), tidak ada perubahan.
//
// CONTOH:
//   SEBELUM .env:
//     EXCHANGE=bybit
//     EXCHANGE_MODE=demo        ← akan dihapus
//     DRY_RUN=1                 ← akan dihapus
//     BYBIT_API_KEY=xxx         ← DIPERTAHANKAN
//   SESUDAH .env:
//     BYBIT_API_KEY=xxx         ← hanya API keys
func (s *Server) sanitizeEnvFile(path string) {
	existing := parseEnvFile(path)
	if len(existing) == 0 {
		return // file tidak ada atau kosong
	}

	// Cek apakah ada non-API-key entries
	dirty := false
	for k := range existing {
		if !apiKeyNames[k] {
			dirty = true
			break
		}
	}
	if !dirty {
		return // already clean, no-op
	}

	// Tulis ulang hanya API keys
	var sb strings.Builder
	sb.WriteString("# TradeBot API Keys\n")
	sb.WriteString("# [FIX-CLEAN-ENV] Non-key settings di-move ke bot_runtime.conf\n")
	sb.WriteString("# Jangan tambahkan EXCHANGE_MODE/DRY_RUN/dll di sini — pakai dashboard\n\n")
	count := 0
	for k, v := range existing {
		if apiKeyNames[k] && v != "" {
			sb.WriteString(fmt.Sprintf("%s=\"%s\"\n", k, v))
			count++
		}
	}

	if err := os.WriteFile(path, []byte(sb.String()), 0o600); err != nil {
		log.Printf("[Gateway] [FIX-CLEAN-ENV] WARNING: gagal sanitize %s: %v", EnvFile, err)
		return
	}
	log.Printf("[Gateway] [FIX-CLEAN-ENV] %s dibersihkan — %d API keys dipertahankan, non-key settings dihapus", EnvFile, count)
	log.Printf("[Gateway] [FIX-CLEAN-ENV] Setting seperti EXCHANGE_MODE/DRY_RUN/LEVERAGE sekarang dibaca dari bot_runtime.conf (disimpan via dashboard Save Config)")
}

// ── [FIX-S4] writeRuntimeConfig ──────────────────────────────────────────────

func (s *Server) writeRuntimeConfig() {
	s.cfgMux.RLock()
	defer s.cfgMux.RUnlock()
	s.writeRuntimeConfigLocked()
}

func (s *Server) writeRuntimeConfigLocked() {
	var sb strings.Builder
	sb.WriteString("# bot_runtime.conf — auto-generated by Go server\n")
	sb.WriteString("# DO NOT EDIT MANUALLY — semua perubahan via dashboard\n\n")
	for k, v := range s.activeCfg {
		if v != "" && !apiKeyNames[k] {
			sb.WriteString(fmt.Sprintf("%s=%s\n", k, v))
		}
	}
	path := filepath.Join(s.baseDir, RuntimeConfigFile)
	if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
		log.Printf("[Gateway] WARNING: failed to write %s: %v", RuntimeConfigFile, err)
	} else {
		style := s.activeCfg["TRADING_STYLE"]
		mode := s.activeCfg["EXCHANGE_MODE"]
		dryrun := s.activeCfg["DRY_RUN"]
		if style == "" {
			style = "(default/scalping)"
		}
		if mode == "" {
			mode = "(default/demo)"
		}
		log.Printf("[Gateway] bot_runtime.conf updated — TRADING_STYLE=%s EXCHANGE_MODE=%s DRY_RUN=%s", style, mode, dryrun)
	}
}

func (s *Server) GetSymbolCh() <-chan string {
	return s.symbolCh
}

// SeedDefaults pushes initial config defaults into activeCfg so bot_runtime.conf
// is populated on first start. Only sets values not already present.
func (s *Server) SeedDefaults(symbol, mode, style string, leverage int, dryrun bool) {
	s.cfgMux.Lock()
	defer s.cfgMux.Unlock()
	defaults := map[string]string{
		"SYMBOL":        symbol,
		"EXCHANGE_MODE": mode,
		"TRADING_STYLE": style,
		"LEVERAGE":      fmt.Sprintf("%d", leverage),
		"DRY_RUN":       fmt.Sprintf("%t", dryrun),
	}
	changed := false
	for k, v := range defaults {
		if _, exists := s.activeCfg[k]; !exists {
			s.activeCfg[k] = v
			changed = true
		}
	}
	if changed {
		s.writeRuntimeConfigLocked()
	}
}

func (s *Server) GetActiveSymbol() string {
	s.cfgMux.RLock()
	defer s.cfgMux.RUnlock()
	return s.activeCfg["SYMBOL"]
}

func (s *Server) IsDryRun() bool {
	s.cfgMux.RLock()
	defer s.cfgMux.RUnlock()
	return s.activeCfg["DRY_RUN"] == "1" || s.activeCfg["DRY_RUN"] == "true"
}

func (s *Server) UpdateInsight(d InsightData) {
	s.mu.Lock()
	s.insight = d
	s.mu.Unlock()
	if b, err := json.Marshal(d); err == nil {
		_ = os.WriteFile(filepath.Join(s.baseDir, InsightFile), b, 0o644)
	}
}

func (s *Server) GetVirtualBalance() float64 {
	s.virtualBalMux.RLock()
	defer s.virtualBalMux.RUnlock()
	return s.virtualBal
}

func (s *Server) SetVirtualBalance(b float64) {
	s.virtualBalMux.Lock()
	s.virtualBal = b
	s.virtualBalMux.Unlock()
	os.WriteFile(filepath.Join(s.baseDir, "virtual_balance.txt"), []byte(fmt.Sprintf("%f", b)), 0o644)
}

func (s *Server) UpdatePositions(active []Position, hist []Position) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activePosList = make([]Position, len(active))
	copy(s.activePosList, active)
	s.history = make([]Position, len(hist))
	copy(s.history, hist)
}

func (s *Server) RefundActiveMargin() {
	s.mu.Lock()
	actives := s.activePosList
	s.mu.Unlock()
	
	if len(actives) > 0 && s.IsDryRun() {
		totalRefund := 0.0
		for _, active := range actives {
			profitUSD := active.Margin * (active.PnL / 100.0)
			totalRefund += active.Margin + profitUSD
		}
		newBal := s.GetVirtualBalance() + totalRefund
		s.SetVirtualBalance(newBal)
		log.Printf("[Server] Refunded %.2f margin+PnL to Virtual Balance during shutdown.", totalRefund)
		
		s.mu.Lock()
		s.activePosList = []Position{}
		s.mu.Unlock()
	}
}

func (s *Server) IsBotRunning() bool {
	return s.botRunning.Load()
}

func (s *Server) Start() {
	s.running.Store(true)
	mux := http.NewServeMux()

	mux.Handle("/dashboard.css", s.staticFile("dashboard.css"))
	mux.Handle("/dashboard.js", s.staticFile("dashboard.js"))
	mux.Handle("/lw-charts.js", s.staticFile("static/lw-charts.js"))
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/dashboard.html" {
			http.ServeFile(w, r, filepath.Join(s.baseDir, "dashboard.html"))
			return
		}
		http.NotFound(w, r)
	})

	mux.HandleFunc("/api/insight", s.handleInsight)
	mux.HandleFunc("/api/positions", s.handlePositions)
	mux.HandleFunc("/api/virtual/inject", s.handleVirtualInject)
	mux.HandleFunc("/api/logs", s.handleLogs)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/get-env", s.handleGetEnv)
	mux.HandleFunc("/api/save-env", s.handleSaveEnv)
	mux.HandleFunc("/api/start", s.handleStart)
	mux.HandleFunc("/api/stop", s.handleStop)
	mux.HandleFunc("/api/clear-logs", s.handleClearLogs)
	mux.HandleFunc("/api/proxy/tickers", s.handleTickers)
	mux.HandleFunc("/api/proxy/fetch", s.handleProxyFetch)
	mux.HandleFunc("/api/proxy/evaluate", s.handleProxyEvaluate)
	mux.HandleFunc("/api/ai_history", s.handleAIHistory)
	mux.HandleFunc("/api/ui-settings", s.handleUISettings)
	mux.HandleFunc("/api/style-agents", s.handleStyleAgents)

	addr := fmt.Sprintf(":%d", Port)
	log.Printf("[Gateway] Dashboard: http://localhost%s", addr)

	mux.HandleFunc("/api/force-execute", s.handleForceExec)

	mux.HandleFunc("/api/backtest/start", func(w http.ResponseWriter, r *http.Request) {
		var req BacktestReq
		if err := json.NewDecoder(r.Body).Decode(&req); err == nil {
			s.SetBacktesting(true)
			s.BacktestReqCh <- req
			w.WriteHeader(http.StatusOK)
		} else {
			http.Error(w, err.Error(), http.StatusBadRequest)
		}
	})

	mux.HandleFunc("/api/backtest/stop", func(w http.ResponseWriter, r *http.Request) {
		s.SetBacktesting(false)
		w.WriteHeader(http.StatusOK)
	})

	srv := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
	}

	go func() {
		<-s.stop
		_ = srv.Close()
	}()

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Printf("[Gateway] Server error: %v", err)
	}
}

func (s *Server) Stop() {
	s.running.Store(false)
	close(s.stop)
}

func (s *Server) handleForceExec(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.forceExec.Store(true)
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"status":"ok", "message":"Force execution requested"}`))
}

func (s *Server) PopForceExec() bool {
	return s.forceExec.CompareAndSwap(true, false)
}

func (s *Server) handleInsight(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	data := s.insight
	s.mu.RUnlock()

	if s.IsDryRun() {
		data.Balance = s.GetVirtualBalance()
	}

	s.jsonOK(w, data)
}

func (s *Server) handlePositions(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	s.jsonOK(w, map[string]interface{}{
		"active":  s.activePosList,
		"history": s.history,
	})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	since := 0
	fmt.Sscanf(r.URL.Query().Get("since"), "%d", &since)

	path := filepath.Join(s.baseDir, LogFile)
	raw, _ := os.ReadFile(path)
	all := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")

	if len(all) > MaxLogLines {
		all = all[len(all)-MaxLogLines:]
	}

	newLines := all
	if since < len(all) {
		newLines = all[since:]
	}

	parsed := make([]LogLine, 0, len(newLines))
	for _, line := range newLines {
		if line == "" {
			continue
		}
		parsed = append(parsed, parseLogLine(line))
	}

	s.jsonOK(w, map[string]interface{}{
		"logs":    parsed,
		"total":   len(all),
		"running": s.botRunning.Load(),
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.jsonOK(w, map[string]bool{"running": s.botRunning.Load()})
}

// handleGetEnv — [FIX-S3] merge .env (API keys only) + in-memory activeCfg
func (s *Server) handleGetEnv(w http.ResponseWriter, r *http.Request) {
	env := parseEnvFile(filepath.Join(s.baseDir, EnvFile))
	s.cfgMux.RLock()
	for k, v := range s.activeCfg {
		if v != "" {
			env[k] = v
		}
	}
	s.cfgMux.RUnlock()
	s.jsonOK(w, map[string]interface{}{"env": env})
}

// handleSaveEnv — [FIX-S2] HANYA tulis API keys ke .env file.
// [FIX-SYMBOL-LIVE] Emit symbolCh saat SYMBOL berubah.
func (s *Server) handleSaveEnv(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.jsonErr(w, err.Error())
		return
	}
	var data map[string]string
	if err := json.Unmarshal(body, &data); err != nil {
		s.jsonErr(w, err.Error())
		return
	}

	s.cfgMux.Lock()
	oldSym := s.activeCfg["SYMBOL"]
	for k, v := range data {
		if !apiKeyNames[k] && v != "" {
			s.activeCfg[k] = v
		}
	}
	newSym := s.activeCfg["SYMBOL"]
	s.cfgMux.Unlock()

	s.writeRuntimeConfig()

	// [FIX-SYMBOL-LIVE] Emit ke symbolCh segera jika SYMBOL berubah.
	if newSym != "" && newSym != oldSym {
		for {
			select {
			case <-s.symbolCh:
			default:
				goto drained
			}
		}
	drained:
		select {
		case s.symbolCh <- newSym:
			log.Printf("[Gateway] [FIX-SYMBOL-LIVE] Pair changed %s → %s", oldSym, newSym)
		default:
			log.Printf("[Gateway] [FIX-SYMBOL-LIVE] WARNING: symbolCh still full after drain, pair=%s", newSym)
		}
	}

	// [FIX-S2] Simpan API keys ke .env
	path := filepath.Join(s.baseDir, EnvFile)
	existing := parseEnvFile(path)
	for k, v := range data {
		if apiKeyNames[k] && v != "" {
			existing[k] = v
		}
	}

	var sb strings.Builder
	sb.WriteString("# TradeBot API Keys\n")
	sb.WriteString("# Semua setting lain disimpan di bot_runtime.conf via dashboard\n\n")
	for k, v := range existing {
		if apiKeyNames[k] {
			sb.WriteString(fmt.Sprintf("%s=\"%s\"\n", k, v))
		}
	}

	if err := os.WriteFile(path, []byte(sb.String()), 0o600); err != nil {
		s.jsonErr(w, err.Error())
		return
	}
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Config saved"})
}

func (s *Server) handleUISettings(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}

	if r.Method == http.MethodGet {
		s.mu.RLock()
		data := s.uiSettings
		s.mu.RUnlock()
		if len(data) == 0 {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("{}"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(data)
		return
	}

	if r.Method == http.MethodPost {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			s.jsonErr(w, err.Error())
			return
		}
		
		s.mu.Lock()
		s.uiSettings = body
		s.mu.Unlock()

		var payload struct {
			DryRunConfig struct {
				InitialBalance float64 `json:"initialBalance"`
			} `json:"dryRunConfig"`
		}
		if err := json.Unmarshal(body, &payload); err == nil && payload.DryRunConfig.InitialBalance > 0 {
			s.virtualBalMux.Lock()
			if payload.DryRunConfig.InitialBalance != s.lastInitBal {
				s.lastInitBal = payload.DryRunConfig.InitialBalance
				s.virtualBal = payload.DryRunConfig.InitialBalance // Hard reset current balance
				if s.baseDir != "" {
					os.WriteFile(filepath.Join(s.baseDir, "virtual_balance.txt"), []byte(fmt.Sprintf("%f", s.virtualBal)), 0o644)
				}
			}
			s.virtualBalMux.Unlock()
		}

		dbDir := ""
	if p := os.Getenv("BOT_DB_PATH"); p != "" {
		dbDir = filepath.Dir(p)
	}
		if dbDir != "" {
			configDir := filepath.Join(dbDir, "config")
			os.MkdirAll(configDir, 0o755)
			uiSettingsPath := filepath.Join(configDir, "ui_settings.bin")
			// Zero latency write to binary file structure
			if err := os.WriteFile(uiSettingsPath, body, 0o644); err != nil {
				log.Printf("[Gateway] Failed to save ui_settings.bin: %v", err)
			}
		}

		s.jsonOK(w, map[string]interface{}{"ok": true})
		return
	}

	http.Error(w, "method not allowed", 405)
}

func (s *Server) handleStyleAgents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	
	s.styleMgr.mu.RLock()
	data := s.styleMgr.agents
	s.styleMgr.mu.RUnlock()

	s.jsonOK(w, data)
}

// handleStart — [FIX-S1] + [FIX-S4] + [FIX-START-ALWAYS]
func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	var incomingCfg map[string]string
	if body, err := io.ReadAll(r.Body); err == nil && len(body) > 2 {
		_ = json.Unmarshal(body, &incomingCfg)
	}

	if incomingCfg != nil {
		s.cfgMux.Lock()
		for k, v := range incomingCfg {
			if !apiKeyNames[k] && v != "" {
				s.activeCfg[k] = v
			}
		}
		newSym := s.activeCfg["SYMBOL"]
		s.cfgMux.Unlock()

		s.writeRuntimeConfig()

		if newSym != "" {
			for {
				select {
				case <-s.symbolCh:
				default:
					goto startDrained
				}
			}
		startDrained:
			select {
			case s.symbolCh <- newSym:
				log.Printf("[Gateway] [FIX-START-ALWAYS] START → feed.UpdateSymbol(%s)", newSym)
			default:
				log.Printf("[Gateway] [FIX-START-ALWAYS] symbolCh full setelah drain, pair=%s", newSym)
			}
		}

		// [FIX-S2] Simpan API keys ke .env jika ada
		hasKeys := false
		for k := range incomingCfg {
			if apiKeyNames[k] {
				hasKeys = true
				break
			}
		}
		if hasKeys {
			path := filepath.Join(s.baseDir, EnvFile)
			existing := parseEnvFile(path)
			for k, v := range incomingCfg {
				if apiKeyNames[k] && v != "" {
					existing[k] = v
				}
			}
			var sb strings.Builder
			sb.WriteString("# TradeBot API Keys\n\n")
			for k, v := range existing {
				if apiKeyNames[k] {
					sb.WriteString(fmt.Sprintf("%s=\"%s\"\n", k, v))
				}
			}
			_ = os.WriteFile(path, []byte(sb.String()), 0o600)
		}
	}

	s.botRunning.Store(true)
	log.Printf("[Gateway] Engine START — pair=%s mode=%s dry=%s",
		s.GetActiveSymbol(),
		func() string {
			s.cfgMux.RLock()
			defer s.cfgMux.RUnlock()
			return s.activeCfg["EXCHANGE_MODE"]
		}(),
		func() string {
			s.cfgMux.RLock()
			defer s.cfgMux.RUnlock()
			return s.activeCfg["DRY_RUN"]
		}(),
	)
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Bot trading engine started."})
}

func (s *Server) handleStop(w http.ResponseWriter, _ *http.Request) {
	s.botRunning.Store(false)
	log.Printf("[Gateway] Engine STOP activated via web UI.")
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Bot trading engine stopped."})
}

func (s *Server) handleClearLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405)
		return
	}
	path := filepath.Join(s.baseDir, LogFile)
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		s.jsonErr(w, err.Error())
		return
	}
	s.jsonOK(w, map[string]bool{"ok": true})
}

func (s *Server) staticFile(name string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(s.baseDir, name))
	})
}

func (s *Server) jsonOK(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(v)
}

func (s *Server) handleVirtualInject(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		Amount float64 `json:"amount"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Bad Request", http.StatusBadRequest)
		return
	}

	s.virtualBalMux.RLock()
	currentBal := s.virtualBal
	s.virtualBalMux.RUnlock()
	
	newBal := currentBal + req.Amount
	if newBal < 0 {
		newBal = 0
	}
	s.SetVirtualBalance(newBal)
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"success": true,
		"balance": newBal,
	})
}

func (s *Server) jsonErr(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(500)
	b, _ := json.Marshal(map[string]string{"ok": "false", "message": msg})
	w.Write(b)
}

func parseLogLine(line string) LogLine {
	if strings.HasPrefix(line, "[MONITOR]") {
		return LogLine{Ts: time.Now().Format("15:04:05"), Level: "WARN", Name: "monitor", Msg: line}
	}

	if strings.HasPrefix(line, "[202") {
		end := strings.IndexByte(line, ']')
		if end > 1 {
			meta := strings.Fields(line[1:end])
			msg := ""
			if end+1 < len(line) {
				msg = strings.TrimSpace(line[end+1:])
			}
			if len(meta) >= 2 {
				ts := meta[0]
				if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
					ts = t.Local().Format("15:04:05")
				} else if len(ts) >= 19 {
					ts = ts[11:19]
				}

				level := "INFO"
				switch strings.ToUpper(meta[1]) {
				case "WARN", "WARNING":
					level = "WARNING"
				case "ERROR":
					level = "ERROR"
				case "DEBUG":
					level = "DEBUG"
				}

				name := "rust"
				if len(meta) >= 3 {
					mod := meta[2]
					if idx := strings.LastIndex(mod, "::"); idx >= 0 {
						name = mod[idx+2:]
					} else {
						name = mod
					}
					name = strings.TrimSuffix(name, "_brain")
					name = strings.TrimSuffix(name, "_engine")
				}

				return LogLine{Ts: ts, Level: level, Name: name, Msg: msg}
			}
		}
	}

	if strings.HasPrefix(line, "202") {
		parts := strings.Fields(line)
		if len(parts) >= 4 {
			ts := parts[1]
			if len(ts) >= 8 {
				ts = ts[:8]
			}
			name := strings.Trim(parts[2], "[]")
			msg := strings.Join(parts[3:], " ")
			return LogLine{Ts: ts, Level: detectLogLevel(msg), Name: name, Msg: msg}
		}
	}

	return LogLine{Ts: time.Now().Format("15:04:05"), Level: "INFO", Name: "sys", Msg: line}
}

func detectLogLevel(msg string) string {
	upper := strings.ToUpper(msg)
	switch {
	case strings.Contains(upper, "ERROR") ||
		strings.Contains(upper, "FAILED") ||
		strings.Contains(upper, "FATAL") ||
		strings.Contains(upper, "PANIC"):
		return "ERROR"
	case strings.Contains(upper, "WARN") ||
		strings.Contains(upper, "CIRCUIT BREAKER") ||
		strings.Contains(upper, "[VETO]") ||
		strings.Contains(upper, "COOLDOWN"):
		return "WARNING"
	case strings.Contains(upper, "DEBUG"):
		return "DEBUG"
	default:
		return "INFO"
	}
}

func parseEnvFile(path string) map[string]string {
	m := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil {
		return m
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || !strings.Contains(line, "=") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		k := strings.TrimSpace(parts[0])
		v := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
		m[k] = v
	}
	return m
}

// [FIX-ISP] Proxy agar dashboard tidak kena blokir CORS / ISP saat fetch Live PnL
func (s *Server) handleTickers(w http.ResponseWriter, r *http.Request) {
	syms := r.URL.Query().Get("symbol")
	var url string
	// Bybit v5 tickers endpoint ONLY accepts a single symbol.
	// If multiple symbols are requested (contains comma) or none, fetch all symbols.
	if syms != "" && !strings.Contains(syms, ",") {
		url = "https://api.bytick.com/v5/market/tickers?category=linear&symbol=" + syms
	} else {
		url = "https://api.bytick.com/v5/market/tickers?category=linear"
	}
	resp, err := http.Get(url)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, resp.Body)
}

// Global client to reuse TCP connections
var proxyClient = &http.Client{
	Timeout: 15 * time.Second,
	Transport: &http.Transport{
		MaxIdleConns:        100,
		MaxIdleConnsPerHost: 100,
		IdleConnTimeout:     90 * time.Second,
	},
}

// [FIX-ARCH] Node.js delegates all CEX API connections to Golang to avoid TS fetch / child_process overheads
func (s *Server) handleProxyFetch(w http.ResponseWriter, r *http.Request) {
	targetUrl := r.URL.Query().Get("url")
	if targetUrl == "" {
		http.Error(w, "Missing url parameter", http.StatusBadRequest)
		return
	}

	req, err := http.NewRequest("GET", targetUrl, nil)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Bypass Cloudflare / WAF just like Chrome does
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
	req.Header.Set("Accept", "application/json")

	resp, err := proxyClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// Proxy for POST /api/evaluate to Rust Brain
func (s *Server) handleProxyEvaluate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	req, err := http.NewRequest("POST", "http://127.0.0.1:8080/api/evaluate", r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := proxyClient.Do(req)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// handleAIHistory handles GET/POST for persistent AI signal history
func (s *Server) handleAIHistory(w http.ResponseWriter, r *http.Request) {
	histFile := filepath.Join(s.baseDir, "history.json")
	if r.Method == http.MethodGet {
		b, err := os.ReadFile(histFile)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("[]"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(b)
		return
	}
	
	if r.Method == http.MethodPost {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		os.WriteFile(histFile, b, 0644)
		w.WriteHeader(http.StatusOK)
		return
	}
	
	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}
