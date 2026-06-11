// rooms/discussion.rs — Room Diskusi: Multi-Agent Parallel Analysis
//
// Semua agent di-clone ke room ini dan melakukan analisa paralel via rayon.
// Output: Vec<AgentVote> (raw, unfiltered)

use crate::shm::MarketSnapshot;
use crate::agents::{Agent, AgentVote};
use std::sync::Arc;
use rayon::prelude::*;

pub struct DiscussionRoom {
    agents: Vec<Arc<dyn Agent + Send + Sync>>,
}

impl DiscussionRoom {
    pub fn new(agents: Vec<Arc<dyn Agent + Send + Sync>>) -> Self {
        Self { agents }
    }

    /// Run all agents in parallel and collect their votes
    pub fn analyze(&self, snap: &MarketSnapshot) -> Vec<AgentVote> {
        self.agents.par_iter().map(|a| a.analyze(snap)).collect()
    }

    pub fn agent_count(&self) -> usize {
        self.agents.len()
    }
}
