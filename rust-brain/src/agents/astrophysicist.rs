use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct Astrophysicist;

impl Agent for Astrophysicist {
    fn name(&self) -> &'static str {
        "astrophysicist"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        if snap.candles.is_empty() {
            return AgentVote::wait(self.name(), "No data");
        }

        let whale_inflow = snap.whale_inflow_usd;
        let oi = snap.oi;

        // Gravity/Mass proxy
        let gravity = whale_inflow / (oi.max(1.0)); // Inflow relative to OI
        
        let direction = if gravity > 0.01 {
            Direction::Buy
        } else if gravity < -0.01 {
            Direction::Sell
        } else {
            Direction::Wait
        };

        let conviction = (gravity.abs() * 10.0).clamp(0.0, 0.85);

        AgentVote {
            agent: self.name(),
            direction,
            conviction,
            reasoning: format!("Whale gravity {:.4}. Stellar mass suggests {:?}", gravity, direction),
        }
    }
}
