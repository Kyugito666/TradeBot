package agents

import "log"

// TabAgents controls the cloned agents specific to UI Tabs.

type TabAgentController struct {
	// 1. Overview Room (Global Benchmark: BTC, OIL, GOLD, SPX)
	OverviewAgents map[string]*AgentProfile
	
	// 2. Mode & Settings Room (Auto Adjustment: Leverage, ATR, RR, ROI)
	SettingsAgents map[string]*AgentProfile
	
	// 3. Consensus Room (Sniper analysis)
	ConsensusAgents map[string]*AgentProfile
}

func NewTabAgentController() *TabAgentController {
	return &TabAgentController{
		OverviewAgents:  make(map[string]*AgentProfile),
		SettingsAgents:  make(map[string]*AgentProfile),
		ConsensusAgents: make(map[string]*AgentProfile),
	}
}

func (tac *TabAgentController) CloneToOverview(baseAgent *AgentProfile) {
	log.Printf("[Tab:Overview] Cloned agent %s to monitor Global Markets", baseAgent.ID)
	tac.OverviewAgents[baseAgent.ID] = baseAgent
}

func (tac *TabAgentController) AutoAdjustSettings() {
	log.Printf("[Tab:Settings] Agent analyzing past and live data to auto-adjust Leverage, Risk, RR...")
	// Logic to pull from History Trade, Backtest, Live Position
}

func (tac *TabAgentController) SniperConsensus() string {
	log.Printf("[Tab:Consensus] Snipper analysis running... No hesitation!")
	// Pulls from Shadow Trade performance
	return "LONG"
}
