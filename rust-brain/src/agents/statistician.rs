use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct Statistician;

impl Agent for Statistician {
    fn name(&self) -> &'static str {
        "statistician"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        if snap.candles.is_empty() {
            return AgentVote::wait(self.name(), "No data");
        }

        let lsr = snap.lsr;
        let funding = snap.funding_rate;
        
        // Statistical arbitrage proxy using LSR and Funding
        // High funding means longs pay shorts. 
        // High LSR means many longs.
        let mut conviction = 0.0;
        let mut direction = Direction::Wait;

        if lsr > 1.2 && funding > 0.0001 {
            direction = Direction::Sell;
            conviction = 0.7;
        } else if lsr < 0.8 && funding < -0.0001 {
            direction = Direction::Buy;
            conviction = 0.7;
        } else {
            if lsr > 1.05 {
                direction = Direction::Buy; // Trend following
                conviction = 0.3;
            } else if lsr < 0.95 {
                direction = Direction::Sell;
                conviction = 0.3;
            }
        }

        AgentVote {
            agent: self.name(),
            direction,
            conviction,
            reasoning: format!("LSR: {:.2}, Funding: {:.4}. Operations Research suggests {:?}", lsr, funding, direction),
        }
    }
}
