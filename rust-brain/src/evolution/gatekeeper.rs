use crate::evolution::AgentPerformance;
use std::collections::HashSet;
use std::sync::Mutex;
use log::{info, warn};

/// Gatekeeper enforces the Military Tatar graduation system.
/// Agents must pass training gates before their votes count in consensus.
///
/// Flow: 
///   1. Agent trains in Python Military Room on historical data
///   2. Python saves results to ORC (D:\database\orc\agents\)
///   3. Rust Gatekeeper reads results and maintains graduated set
///   4. Consensus only counts votes from graduated agents
///
/// Thresholds (matching Python military_room.py):
///   - GRADUATE: win_rate >= 60% OR win_streak >= 5 (and total_trades >= 10)
///   - DEMOTE: win_rate < 45% OR loss_streak >= 3
#[allow(dead_code)]
pub struct Gatekeeper {
    graduated: Mutex<HashSet<String>>,
}

#[allow(dead_code)]
impl Gatekeeper {
    pub fn new() -> Self {
        // Start by assuming all agents are graduated (backwards compat)
        // Python Military Room will refine this via /api/ml/graduated_agents
        let mut initial = HashSet::new();
        let default_agents = [
            "mathematician", "physicist", "cryptographer", "statistician",
            "economist", "game_theorist", "data_engineer", "data_scientist",
            "linguist", "liquidator", "absurdist", "psychologist", 
            "astrophysicist", "treasury_manager",
        ];
        for a in &default_agents {
            initial.insert(a.to_string());
        }
        info!("[Gatekeeper] Initialized with {} agents (all graduated by default)", initial.len());
        Self {
            graduated: Mutex::new(initial),
        }
    }

    /// Check if an agent has graduated from Military Tatar training
    pub fn is_graduated(&self, agent_name: &str) -> bool {
        self.graduated.lock().unwrap().contains(agent_name)
    }

    /// Update graduation status from live performance
    pub fn check_graduation(perf: &AgentPerformance) -> bool {
        (perf.win_rate >= 60.0 || perf.win_streak >= 5) && perf.total_trades >= 10
    }

    pub fn check_demotion(perf: &AgentPerformance) -> bool {
        perf.total_trades >= 10 && (perf.loss_streak >= 3 || perf.win_rate < 45.0)
    }

    /// Update a specific agent's graduation status
    pub fn update_agent(&self, agent_name: &str, perf: &AgentPerformance) {
        let mut graduated = self.graduated.lock().unwrap();
        if Self::check_graduation(perf) {
            if graduated.insert(agent_name.to_string()) {
                info!("[Gatekeeper] ✅ {} GRADUATED (WR={:.1}%, WS={})", 
                    agent_name, perf.win_rate, perf.win_streak);
            }
        } else if Self::check_demotion(perf) {
            if graduated.remove(agent_name) {
                warn!("[Gatekeeper] ⚠️ {} DEMOTED (WR={:.1}%, LS={})", 
                    agent_name, perf.win_rate, perf.loss_streak);
            }
        }
    }

    /// Bulk update from Python Military Room results
    pub fn sync_graduated(&self, graduated_list: Vec<String>) {
        let mut graduated = self.graduated.lock().unwrap();
        *graduated = graduated_list.into_iter().collect();
        info!("[Gatekeeper] Synced {} graduated agents from Military Room", graduated.len());
    }

    /// Get list of all currently graduated agents
    pub fn get_graduated(&self) -> Vec<String> {
        self.graduated.lock().unwrap().iter().cloned().collect()
    }

    /// Filter votes: only keep votes from graduated agents
    pub fn filter_votes<'a>(&self, votes: &'a [(String, crate::agents::Direction, f64)]) 
        -> Vec<&'a (String, crate::agents::Direction, f64)> 
    {
        let graduated = self.graduated.lock().unwrap();
        votes.iter()
            .filter(|(name, _, _)| graduated.contains(name))
            .collect()
    }
}
