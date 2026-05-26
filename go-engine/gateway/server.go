// go-engine/gateway/server.go
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
	Port        = 8765
	LogFile     = "bot.log"
	InsightFile = "bot_insight.json"
	EnvFile     = ".env"
	MaxLogLines = 500
)

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

// Data model untuk Live Paper Trading
type Position struct {
	Side       string  `json:"side"`
	EntryPrice float64 `json:"entry_price"`
	TakeProfit float64 `json:"take_profit"`
	StopLoss   float64 `json:"stop_loss"`
	Time       string  `json:"time"`
	Status     string  `json:"status"` // OPEN, CLOSED_TP, CLOSED_SL
	PnL        float64 `json:"pnl"`
}

type Server struct {
	mu         sync.RWMutex
	insight    InsightData
	running    atomic.Bool
	botRunning atomic.Bool
	stop       chan struct{}
	baseDir    string

	// Storage in-memory untuk Paper Trading
	activePos *Position
	history   []Position
}

func New(baseDir string) *Server {
	s := &Server{
		stop:    make(chan struct{}),
		baseDir: baseDir,
		insight: InsightData{SignalStatus: "WAIT", TrendState: "RANGING"},
		history: make([]Position, 0),
	}
	s.botRunning.Store(false)
	return s
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

func (s *Server) handleGetEnv(w http.ResponseWriter, r *http.Request) {
	env := parseEnvFile(filepath.Join(s.baseDir, EnvFile))
	s.jsonOK(w, map[string]interface{}{"env": env})
}

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

	path := filepath.Join(s.baseDir, EnvFile)
	var sb strings.Builder
	for k, v := range data {
		sb.WriteString(fmt.Sprintf("%s=\"%s\"\n", k, v))
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0o600); err != nil {
		s.jsonErr(w, err.Error())
		return
	}
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Config saved"})
}

func (s *Server) handleStart(w http.ResponseWriter, _ *http.Request) {
	s.botRunning.Store(true)
	log.Printf("[Dashboard] Engine START activated via web UI.")
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

// parseLogLine normalises both Go and Rust log lines to a consistent LogLine.
//
// Go  log format : 2026/05/26 13:14:07.123456 [module] message   (already local time)
// Rust log format: [2026-05-26T06:14:07.123Z INFO module::path] message (UTC → convert to local)
func parseLogLine(line string) LogLine {
	if strings.HasPrefix(line, "[MONITOR]") {
		return LogLine{Ts: time.Now().Format("15:04:05"), Level: "WARN", Name: "monitor", Msg: line}
	}

	// ── Rust env_logger ───────────────────────────────────────────────────────
	// [2026-05-26T06:14:07.123456Z INFO tradebot_brain::consensus::mod] message
	if strings.HasPrefix(line, "[202") {
		end := strings.IndexByte(line, ']')
		if end > 1 {
			meta := strings.Fields(line[1:end])
			msg := ""
			if end+1 < len(line) {
				msg = strings.TrimSpace(line[end+1:])
			}
			if len(meta) >= 2 {
				// UTC timestamp → local (WIB / device timezone)
				ts := meta[0]
				if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
					ts = t.Local().Format("15:04:05")
				} else if len(ts) >= 19 {
					ts = ts[11:19] // fallback: raw HH:MM:SS from UTC string
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

				// "tradebot_brain::consensus::mod" → "consensus"
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

	// ── Go log package ────────────────────────────────────────────────────────
	// 2026/05/26 13:14:07.123456 [module] message
	if strings.HasPrefix(line, "202") {
		parts := strings.Fields(line)
		if len(parts) >= 4 {
			ts := parts[1]
			if len(ts) >= 8 {
				ts = ts[:8] // HH:MM:SS — already local time
			}
			name := strings.Trim(parts[2], "[]")
			msg := strings.Join(parts[3:], " ")
			return LogLine{Ts: ts, Level: detectLogLevel(msg), Name: name, Msg: msg}
		}
	}

	return LogLine{Ts: time.Now().Format("15:04:05"), Level: "INFO", Name: "sys", Msg: line}
}

// detectLogLevel infers level from Go log message content.
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
