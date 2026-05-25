// go-engine/gateway/server.go
//
// Dashboard HTTP Server — replaces bot_server.py
// ================================================
// Serves the existing dashboard.html / .js / .css without ANY change to the UI.
// Provides EXACTLY the same REST endpoints bot_server.py exposed:
//
//   GET  /                  → dashboard.html
//   GET  /api/insight       → bot_insight.json content
//   GET  /api/logs          → last N log lines
//   GET  /api/status        → {"running": bool}
//   GET  /api/get-env       → current .env values
//   POST /api/save-env      → write .env
//   POST /api/start         → no-op (Go engine is always running)
//   POST /api/stop          → graceful shutdown signal
//   POST /api/clear-logs    → truncate log file
//
// bot_insight.json schema is IDENTICAL to what Python produced, so dashboard.js
// requires ZERO changes.

package gateway

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
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

// InsightData mirrors what Python main.py wrote to bot_insight.json.
// All field names are IDENTICAL so dashboard.js needs no changes.
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

// LogLine matches the parse format in dashboard.js
type LogLine struct {
	Ts    string `json:"ts"`
	Level string `json:"level"`
	Name  string `json:"name"`
	Msg   string `json:"msg"`
}

// Server is the HTTP server with a shared insight cache
type Server struct {
	mu      sync.RWMutex
	insight InsightData
	running atomic.Bool
	stop    chan struct{}
	baseDir string
}

var logLineRE = regexp.MustCompile(
	`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ \[(\w+)\] (.+?) - (.+)$`,
)

func New(baseDir string) *Server {
	return &Server{
		stop:    make(chan struct{}),
		baseDir: baseDir,
		insight: InsightData{SignalStatus: "WAIT", TrendState: "RANGING"},
	}
}

// UpdateInsight is called by the orchestrator on every consensus cycle
func (s *Server) UpdateInsight(d InsightData) {
	s.mu.Lock()
	s.insight = d
	s.mu.Unlock()

	// Also write to file so any external tool can read it
	if b, err := json.Marshal(d); err == nil {
		path := filepath.Join(s.baseDir, InsightFile)
		_ = os.WriteFile(path, b, 0o644)
	}
}

// Start launches the HTTP server; blocks until ctx is cancelled or Stop is called
func (s *Server) Start() {
	s.running.Store(true)
	mux := http.NewServeMux()

	// Static files: serve from baseDir (where dashboard.html lives)
	mux.Handle("/dashboard.css", s.staticFile("dashboard.css"))
	mux.Handle("/dashboard.js",  s.staticFile("dashboard.js"))
	mux.Handle("/lw-charts.js",  s.staticFile("static/lw-charts.js"))

	// Root → dashboard.html
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/dashboard.html" {
			http.ServeFile(w, r, filepath.Join(s.baseDir, "dashboard.html"))
			return
		}
		http.NotFound(w, r)
	})

	// API
	mux.HandleFunc("/api/insight",    s.handleInsight)
	mux.HandleFunc("/api/logs",       s.handleLogs)
	mux.HandleFunc("/api/status",     s.handleStatus)
	mux.HandleFunc("/api/get-env",    s.handleGetEnv)
	mux.HandleFunc("/api/save-env",   s.handleSaveEnv)
	mux.HandleFunc("/api/start",      s.handleStart)
	mux.HandleFunc("/api/stop",       s.handleStop)
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

// ── Handlers ─────────────────────────────────────────────────────────────────

func (s *Server) handleInsight(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	d := s.insight
	s.mu.RUnlock()
	s.jsonOK(w, d)
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	since := 0
	fmt.Sscanf(r.URL.Query().Get("since"), "%d", &since)

	path := filepath.Join(s.baseDir, LogFile)
	raw, _ := os.ReadFile(path)
	all := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")

	// Keep last 500
	if len(all) > MaxLogLines {
		all = all[len(all)-MaxLogLines:]
	}

	newLines := all
	if since < len(all) {
		newLines = all[since:]
	}

	parsed := make([]LogLine, 0, len(newLines))
	for _, line := range newLines {
		if line == "" { continue }
		parsed = append(parsed, parseLogLine(line))
	}

	s.jsonOK(w, map[string]interface{}{
		"logs":    parsed,
		"total":   len(all),
		"running": s.running.Load(),
	})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	s.jsonOK(w, map[string]bool{"running": s.running.Load()})
}

func (s *Server) handleGetEnv(w http.ResponseWriter, r *http.Request) {
	env := parseEnvFile(filepath.Join(s.baseDir, EnvFile))
	s.jsonOK(w, map[string]interface{}{"env": env})
}

func (s *Server) handleSaveEnv(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405); return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil { s.jsonErr(w, err.Error()); return }
	var data map[string]string
	if err := json.Unmarshal(body, &data); err != nil { s.jsonErr(w, err.Error()); return }

	path := filepath.Join(s.baseDir, EnvFile)
	var sb strings.Builder
	for k, v := range data {
		sb.WriteString(fmt.Sprintf("%s=\"%s\"\n", k, v))
	}
	if err := os.WriteFile(path, []byte(sb.String()), 0o600); err != nil {
		s.jsonErr(w, err.Error()); return
	}
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Config saved"})
}

func (s *Server) handleStart(w http.ResponseWriter, _ *http.Request) {
	// Go engine is always running — this is a no-op kept for UI compat
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Go engine is always running."})
}

func (s *Server) handleStop(w http.ResponseWriter, _ *http.Request) {
	s.jsonOK(w, map[string]interface{}{"ok": true, "message": "Shutdown signal sent."})
	go func() {
		time.Sleep(300 * time.Millisecond)
		s.Stop()
	}()
}

func (s *Server) handleClearLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", 405); return
	}
	path := filepath.Join(s.baseDir, LogFile)
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		s.jsonErr(w, err.Error()); return
	}
	s.jsonOK(w, map[string]bool{"ok": true})
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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
	m := logLineRE.FindStringSubmatch(line)
	if m != nil {
		ts := ""
		if len(m[1]) >= 16 { ts = m[1][11:16] }
		name := m[3]
		if len(name) > 14 { name = name[len(name)-14:] }
		return LogLine{Ts: ts, Level: m[2], Name: name, Msg: m[4]}
	}
	return LogLine{Ts: "--:--", Level: "INFO", Name: "engine", Msg: line}
}

func parseEnvFile(path string) map[string]string {
	m := map[string]string{}
	data, err := os.ReadFile(path)
	if err != nil { return m }
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
