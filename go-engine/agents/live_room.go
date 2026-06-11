package agents

import (
	"log"
)

// LiveRoom handles the agents that passed Militer Tatar.
type LiveRoom struct {
	ActiveAgents map[string]*AgentProfile
}

func NewLiveRoom() *LiveRoom {
	return &LiveRoom{
		ActiveAgents: make(map[string]*AgentProfile),
	}
}

// AdmitAgent adds a graduated agent to the Live Room.
func (lr *LiveRoom) AdmitAgent(agent *AgentProfile) {
	if agent.IsGraduated {
		lr.ActiveAgents[agent.ID] = agent
		log.Printf("[LiveRoom] Welcome Agent %s! Ready to analyze Live Market.", agent.ID)
	}
}

// EvictAgent kicks out an underperforming agent back to Militer Tatar.
func (lr *LiveRoom) EvictAgent(id string) {
	if _, exists := lr.ActiveAgents[id]; exists {
		delete(lr.ActiveAgents, id)
		log.Printf("[LiveRoom] Agent %s evicted due to low winrate/loss streak.", id)
	}
}

// Consensus gathers votes (LONG/SHORT/VETO) from all active agents.
// Note: NO HOLD/WAIT allowed in Live Room!
func (lr *LiveRoom) Consensus(tickData []byte) string {
	longVotes := 0
	shortVotes := 0
	vetoes := 0

	// Pseudo-voting logic
	for _, _ = range lr.ActiveAgents {
		// Agents analyze tickData via IPC to Rust
		vetoes++
	}

	if vetoes > len(lr.ActiveAgents)/2 {
		return "VETO"
	}
	if longVotes > shortVotes {
		return "LONG"
	}
	return "SHORT"
}
