package agents

import (
	"log"
)

// AgentProfile represents an agent's studying field and performance metrics.
type AgentProfile struct {
	ID          string
	Field       string // e.g., "Mathematics", "Physics", "GameTheory"
	WinRate     float64
	WinStreak   int
	LossStreak  int
	TotalTrades int
	IsGraduated bool
}

// TrainingRoom handles the backtesting simulations ("Pendidikan Militer Tatar").
type TrainingRoom struct {
	Agents map[string]*AgentProfile
}

func NewTrainingRoom() *TrainingRoom {
	return &TrainingRoom{
		Agents: make(map[string]*AgentProfile),
	}
}

func (tr *TrainingRoom) RegisterAgent(id string, field string) {
	tr.Agents[id] = &AgentProfile{
		ID:          id,
		Field:       field,
		WinRate:     0.0,
		WinStreak:   0,
		LossStreak:  0,
		TotalTrades: 0,
		IsGraduated: false,
	}
	log.Printf("[Militer Tatar] Agent %s (%s) registered for training.", id, field)
}

// EvaluatePerformance is called after a backtest epoch.
func (tr *TrainingRoom) EvaluatePerformance(id string, won bool) {
	agent, exists := tr.Agents[id]
	if !exists {
		return
	}

	agent.TotalTrades++
	if won {
		agent.WinStreak++
		agent.LossStreak = 0
	} else {
		agent.LossStreak++
		agent.WinStreak = 0
	}

	// Pseudo-calculation for win rate
	// In reality, we'd calculate from historical trades DB (ORC)
	agent.WinRate = float64(agent.WinStreak) / float64(agent.TotalTrades) * 100.0
	if agent.WinRate > 100 {
		agent.WinRate = 100
	}

	tr.CheckGraduation(agent)
}

func (tr *TrainingRoom) CheckGraduation(agent *AgentProfile) {
	if agent.IsGraduated {
		// If already in Live Market, check if they need to be demoted
		if agent.WinRate < 45.0 || agent.LossStreak >= 3 {
			agent.IsGraduated = false
			log.Printf("[Militer Tatar] ALERT! Agent %s demoted back to training room (WinRate: %.2f%%, LossStreak: %d)", agent.ID, agent.WinRate, agent.LossStreak)
		}
	} else {
		// Check if they can graduate to Live Market
		if agent.WinRate >= 60.0 || agent.WinStreak >= 5 {
			agent.IsGraduated = true
			log.Printf("[Militer Tatar] SUCCESS! Agent %s graduated to LIVE MARKET! (WinRate: %.2f%%, WinStreak: %d)", agent.ID, agent.WinRate, agent.WinStreak)
		}
	}
}
