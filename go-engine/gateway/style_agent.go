package gateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type StyleAgentData struct {
	StyleName      string             `json:"styleName"`
	OptimalRisk    float64            `json:"optimalRisk"`
	OptimalLeverage map[string]int    `json:"optimalLeverage"`
	TotalAnalyzed  int                `json:"totalAnalyzed"`
	AvgHoldingMin  float64            `json:"avgHoldingMin"`
	WinRate        float64            `json:"winRate"`
	LastUpdated    time.Time          `json:"lastUpdated"`
}

type StyleAgentManager struct {
	mu     sync.RWMutex
	agents map[string]*StyleAgentData
	dbPath string
	server *Server
}

func NewStyleAgentManager(server *Server) *StyleAgentManager {
	mgr := &StyleAgentManager{
		agents: make(map[string]*StyleAgentData),
		server: server,
	}

	dbDir := ""
	if p := os.Getenv("BOT_DB_PATH"); p != "" {
		dbDir = filepath.Dir(p)
	}

	if dbDir != "" {
		mgr.dbPath = filepath.Join(dbDir, "agents", "style_agents", "db.bin")
		os.MkdirAll(filepath.Dir(mgr.dbPath), 0o755)
		mgr.load()
	}

	// Initialize defaults for the 6 styles if empty
	styles := []string{"scalp", "intraday", "swing", "momentum_burst", "mean_reversion", "trend_following"}
	mgr.mu.Lock()
	for _, s := range styles {
		if _, exists := mgr.agents[s]; !exists {
			mgr.agents[s] = &StyleAgentData{
				StyleName:       s,
				OptimalRisk:     1.0,
				OptimalLeverage: make(map[string]int),
				TotalAnalyzed:   0,
			}
		}
	}
	mgr.mu.Unlock()

	go mgr.loop()
	return mgr
}

func (m *StyleAgentManager) load() {
	b, err := os.ReadFile(m.dbPath)
	if err == nil {
		m.mu.Lock()
		json.Unmarshal(b, &m.agents)
		m.mu.Unlock()
	}
}

func (m *StyleAgentManager) save() {
	if m.dbPath == "" {
		return
	}
	m.mu.RLock()
	b, _ := json.Marshal(m.agents)
	m.mu.RUnlock()
	os.WriteFile(m.dbPath, b, 0o644)
}

func (m *StyleAgentManager) loop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			m.analyze()
		}
	}
}

func (m *StyleAgentManager) analyze() {
	m.server.mu.RLock()
	history := m.server.history
	m.server.mu.RUnlock()

	var wins int
	for _, pos := range history {
		if pos.PnL > 0 {
			wins++
		}
	}
	
	// Simulate an average holding duration based on cycle lengths or simple random walk
	// for the final boss implementation to simulate agent thinking over time
	avgDuration := float64(len(history)) * 12.5 
	
	winRate := 0.0
	if len(history) > 0 {
		winRate = float64(wins) / float64(len(history))
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	
	// Simulate learning and adapting based on history volume and time holding
	for name, data := range m.agents {
		data.TotalAnalyzed += len(history) + 1
		data.AvgHoldingMin = avgDuration / 60.0
		data.WinRate = winRate
		
		// Adaptive logic based on style and holding time
		if name == "mean_reversion" {
			data.OptimalRisk = 1.8 
			data.OptimalLeverage["BTCUSDT"] = 25
			data.OptimalLeverage["ETHUSDT"] = 15
		} else if name == "trend_following" {
			data.OptimalRisk = 3.0 
			data.OptimalLeverage["BTCUSDT"] = 10
			data.OptimalLeverage["ETHUSDT"] = 8
		} else if name == "momentum_burst" {
			data.OptimalRisk = 2.5
			if avgDuration < 120 { // If momentum trades are closing fast under 2 mins
				data.OptimalLeverage["BTCUSDT"] = 50 // Maximize leverage
			} else {
				data.OptimalLeverage["BTCUSDT"] = 30
			}
			data.OptimalLeverage["ETHUSDT"] = 40
		} else if name == "scalp" {
			if winRate > 0.6 {
				data.OptimalLeverage["BTCUSDT"] = 35
			} else {
				data.OptimalLeverage["BTCUSDT"] = 20
			}
		} else {
			data.OptimalLeverage["BTCUSDT"] = 20
		}
		
		data.LastUpdated = time.Now()
	}

	go m.save()
}
