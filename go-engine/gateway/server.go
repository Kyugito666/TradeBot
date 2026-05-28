// go-engine/gateway/server.go
// ═══════════════════════════════════════════════════════════════════════════════
// CHANGELOG:
//
// [FIX-S1] DYNAMIC SYMBOL — handleStart baca SYMBOL dari request body.
//          Kirim ke main.go via GetSymbolCh() → feed.UpdateSymbol().
//
// [FIX-S2] ENV FILE HANYA SIMPAN API KEYS.
//          SYMBOL, LEVERAGE, EXCHANGE, dll = browser-only (localStorage).
//          handleSaveEnv filter field non-key sebelum tulis ke disk .env.
//
// [FIX-S3] handleGetEnv merge .env (API keys only) + in-memory activeCfg.
//
// [FIX-S4] ← NEW — writeRuntimeConfig
//   ROOT CAUSE: consensus/mod.rs (Rust) baca TRADING_STYLE dari .env via
//   OnceLock. Tapi setelah FIX-S2, .env HANYA berisi API keys — sehingga
//   Rust tidak pernah nemu TRADING_STYLE dan selalu fallback ke "scalping".
//   Akibatnya: bot selalu pakai scalping config (tp_atr_mult=1.2, min_conf=0.18)
//   meski user set ke daytrade atau sniper di dashboard.
//
//   FIX: Tulis bot_runtime.conf dengan semua non-key settings (TRADING_STYLE,
//   LEVERAGE, SYMBOL, dll) setiap kali activeCfg diupdate. Rust brain baca
//   dari bot_runtime.conf — bukan .env.
//
//   Dipanggil dari:
//   - New()          → tulis defaults dari .env lama (backward compat)
//   - handleSaveEnv  → tiap user ubah setting di dashboard (auto-save)
//   - handleStart    → saat START ditekan (pastikan style terupdate)
//
//   File berikutnya yang perlu diupdate: rust-brain/src/consensus/mod.rs
//   → ubah baca dari "bot_runtime.conf" bukan ".env"
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
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	Port              = 8765
	LogFile           = "bot.log"
	InsightFile       = "bot_insight.json"
	EnvFile           = ".env"
	RuntimeConfigFile = "bot_runtime.conf" // [FIX-S4] non-key settings untuk Rust brain
	MaxLogLines       = 500
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
}

type InsightData struct {
	Symbol       string  `json:"symbol"`
	LastPrice    float64 `json:"last_price"`
	OpenInterest float64 `json:"open_interest"`
	LSRVal       float64 `json:"lsr_val"`
	Pct24h       float64 `json:"pct_24h"`
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
	Side       string  `json:"side"`
	EntryPrice float64 `json:"entry_price"`
	TakeProfit float64 `json:"take_profit"`
	StopLoss   float64 `json:"stop_loss"`
	Time       string  `json:"time"`
	Status     string  `json:"status"`
	PnL        float64 `json:"pnl"`
}

type Server struct {
	mu         sync.RWMutex
	insight    InsightData
	running    atomic.Bool
	botRunning atomic.Bool
	stop       chan struct{}
	baseDir    string

	// Paper trading state
	activePos *Position
	history   []Position

	// [FIX-S1] Browser-driven config
	symbolCh  chan string
	activeCfg map[string]string
}

func New(baseDir string) *Server {
	s := &Server{
		stop:      make(chan struct{}),
		baseDir:   baseDir,
		insight:   InsightData{SignalStatus: "WAIT", TrendState: "RANGING"},
		history:   make([]Position, 0),
		symbolCh:  make(chan string, 1),
		activeCfg: make(map[string]string),
	}
	s.botRunning.Store(false)

	// [FIX-S4] Seed activeCfg dari .env lama (backward compat).
	// Kalau user punya .env lama yang masih ada TRADING_STYLE dll,
	// load ke activeCfg supaya bot_runtime.conf langsung ada isinya
	// sebelum user buka dashboard.
	existing := parseEnvFile(filepath.Join(baseDir, EnvFile))
	for k, v := range existing {
		if !apiKeyNames[k] && v != "" {
			s.activeCfg[k] = v
		}
	}

	// [FIX-S4] Tulis bot_runtime.conf awal — Rust brain baca ini saat startup.
	// Kalau .env lama punya TRADING_STYLE, Rust langsung pakai itu.
	// Kalau kosong, Rust fallback ke default "scalping" (sama seperti sebelumnya
	// tapi sekarang lewat file yang bisa diupdate tanpa restart).
	s.writeRuntimeConfigLocked()

	return s
}

// ── [FIX-S4] writeRuntimeConfig ──────────────────────────────────────────────
//
// writeRuntimeConfig adalah PUBLIC wrapper yang acquire RLock sebelum nulis.
// Dipanggil dari handleSaveEnv dan handleStart (di luar mutex context).
func (s *Server) writeRuntimeConfig() {
	s.mu.RLock()
	defer s.mu.RUnlock()
	s.writeRuntimeConfigLocked()
}

// writeRuntimeConfigLocked nulis bot_runtime.conf TANPA acquire lock.
// Dipanggil dari New() (sebelum goroutine lain jalan) dan dari dalam Lock context.
// [FIX-S4] File ini dibaca Rust brain (consensus/mod.rs) untuk TRADING_STYLE dll.
func (s *Server) writeRuntimeConfigLocked() {
	var sb strings.Builder
	sb.WriteString("# bot_runtime.conf — auto-generated by Go server\n")
	sb.WriteString("# DO NOT EDIT MANUALLY — diupdate otomatis saat settings berubah di dashboard\n")
	sb.WriteString("# Dibaca oleh: rust-brain/src/consensus/mod.rs untuk TRADING_STYLE\n\n")

	// [FIX-S4] Tulis semua non-key settings dari activeCfg
	for k, v := range s.activeCfg {
		if v != "" && !apiKeyNames[k] {
			sb.WriteString(fmt.Sprintf("%s=%s\n", k, v))
		}
	}

	path := filepath.Join(s.baseDir, RuntimeConfigFile)
	if err := os.WriteFile(path, []byte(sb.String()), 0o644); err != nil {
		log.Printf("[Gateway] [FIX-S4] WARNING: failed to write %s: %v", RuntimeConfigFile, err)
	} else {
		style := s.activeCfg["TRADING_STYLE"]
		if style == "" {
			style = "(default/scalping)"
		}
		log.Printf("[Gateway] [FIX-S4] bot_runtime.conf updated — TRADING_STYLE=%s", style)
	}
}

// GetSymbolCh returns receive-only channel yang emit symbol baru saat user START
func (s *Server) GetSymbolCh() <-chan string {
	return s.symbolCh
}

// GetActiveSymbol returns pair yang sedang aktif dipilih di dashboard.
func (s *Server) GetActiveSymbol() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activeCfg["SYMBOL"]
}

func (s *Server) UpdateInsight(d InsightData) {
	s.mu.Lock()
	s.insight = d
	s.mu.Unlock()

	if b, err := json.Marshal(d); err == nil {
		path := filepath.Join(s.baseDir, InsightFile)
		_ = os.WriteFile(path, b, 0o644)
	}
}

func (s *Server) UpdatePositions(active *Position, hist []Position) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if active != nil {
		p := *active
		s.activePos = &p
	} else {
		s.activePos = nil
	}

	s.history = make([]Position, len(hist))
	copy(s.history, hist)
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

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/dashboard.html" {
			http.ServeFile(w, r, filepath.Join(s.baseDir, "dashboard.html"))
			return
		}
		http.NotFound(w, r)
	})

	mux.HandleFunc("/api/insight", s.handleInsight)
	mux.HandleFunc("/api/positions", s.handlePositions)
	mux.HandleFunc("/api/logs", s.handleLogs)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/get-env", s.handleGetEnv)
	mux.HandleFunc("/api/save-env", s.handleSaveEnv)
	mux.HandleFunc("/api/start", s.handleStart)
	mux.HandleFunc("/api/stop", s.handleStop)
	mux.HandleFunc("/api/clear-logs", s.handleClearLogs)

	addr := fmt.Sprintf(":%d", Port)
	log.Printf("[Gateway] Dashboard: http://localhost%s", addr)

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

func (s *Server) handleInsight(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	d := s.insight
	s.mu.RUnlock()
	s.jsonOK(w, d)
}

func (s *Server) handlePositions(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	activeArr := []Position{}
	if s.activePos != nil {
		activeArr = append(activeArr, *s.activePos)
	}

	s.jsonOK(w, map[string]interface{}{
		"active":  activeArr,
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

	s.mu.RLock()
	for k, v := range s.activeCfg {
		if v != "" {
			env[k] = v
		}
	}
	s.mu.RUnlock()

	s.jsonOK(w, map[string]interface{}{"env": env})
}

// handleSaveEnv — [FIX-S2] HANYA tulis API keys ke .env file.
// [FIX-S4] Tulis bot_runtime.conf dengan non-key settings untuk Rust.
func (s *Server) handleSaveEnv(w http.ResponseWriter, r *http.Request) {
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

	// [FIX-S2] Simpan non-key settings ke in-memory activeCfg
	s.mu.Lock()
	for k, v := range data {
		if !apiKeyNames[k] && v != "" {
			s.activeCfg[k] = v
		}
	}
	s.mu.Unlock()

	// [FIX-S4] Tulis bot_runtime.conf setelah activeCfg diupdate.
	// Rust brain baca ini untuk TRADING_STYLE dan setting lainnya.
	s.writeRuntimeConfig()

	// [FIX-S2] Baca existing .env, update API keys, tulis ulang — HANYA API keys
	path := filepath.Join(s.baseDir, EnvFile)
	existing := parseEnvFile(path)

	for k, v := range data {
		if apiKeyNames[k] && v != "" {
			existing[k] = v
		}
	}

	var sb strings.Builder
	sb.WriteString("# TradeBot API Keys\n")
	sb.WriteString("# Semua setting lain (symbol, leverage, dll) disimpan di browser localStorage\n\n")
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

// handleStart — [FIX-S1] Baca SYMBOL dari request body, update feed via channel.
// [FIX-S4] Tulis bot_runtime.conf setelah activeCfg diupdate.
func (s *Server) handleStart(w http.ResponseWriter, r *http.Request) {
	var incomingCfg map[string]string
	if body, err := io.ReadAll(r.Body); err == nil && len(body) > 2 {
		_ = json.Unmarshal(body, &incomingCfg)
	}

	if incomingCfg != nil {
		s.mu.Lock()
		oldSym := s.activeCfg["SYMBOL"]

		for k, v := range incomingCfg {
			if !apiKeyNames[k] && v != "" {
				s.activeCfg[k] = v
			}
		}
		newSym := s.activeCfg["SYMBOL"]
		s.mu.Unlock()

		// [FIX-S4] Tulis bot_runtime.conf dengan config terbaru (termasuk TRADING_STYLE).
		// Dipanggil SETELAH mutex unlock — no deadlock.
		s.writeRuntimeConfig()

		// [FIX-S1] Notify feed jika symbol berubah
		if newSym != "" && newSym != oldSym {
			select {
			case <-s.symbolCh:
			default:
			}
			select {
			case s.symbolCh <- newSym:
				log.Printf("[Dashboard] [FIX-S1] Symbol: %s → %s (browser-driven, no restart needed)", oldSym, newSym)
			default:
			}
		} else if newSym != "" {
			log.Printf("[Dashboard] START: symbol=%s (unchanged)", newSym)
		}

		// [FIX-S2] Simpan API keys ke .env jika ada dalam request
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
	log.Printf("[Dashboard] Engine START — pair=%s", s.GetActiveSymbol())
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Bot trading engine started."})
}

func (s *Server) handleStop(w http.ResponseWriter, _ *http.Request) {
	s.botRunning.Store(false)
	log.Printf("[Dashboard] Engine STOP activated via web UI. Orders locked to WAIT.")
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
	b, _ := json.Marshal(v)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(b)
}

func (s *Server) jsonErr(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "application/json")
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
