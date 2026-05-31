use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct DataScientist;

impl Agent for DataScientist {
    fn name(&self) -> &'static str {
        "data_scientist"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        if snap.candles.is_empty() {
            return AgentVote::wait(self.name(), "No data");
        }

        // Mock AI/ML model proxy using standard deviation and recent velocity
        let len = snap.candles.len();
        let recent = len.min(10);
        let mut sum = 0.0;
        for i in (len - recent)..len {
            sum += snap.candles[i].close;
        }
        let mean = sum / recent as f64;

        let mut variance = 0.0;
        for i in (len - recent)..len {
            variance += (snap.candles[i].close - mean).powi(2);
        }
        let std_dev = (variance / recent as f64).sqrt();

        let z_score = if std_dev > 0.0 { (snap.price - mean) / std_dev } else { 0.0 };

        let direction = if z_score > 2.0 {
            // Mean reversion expected
            Direction::Sell
        } else if z_score < -2.0 {
            Direction::Buy
        } else if z_score > 0.5 {
            // Trend following
            Direction::Buy
        } else if z_score < -0.5 {
            Direction::Sell
        } else {
            Direction::Wait
        };

        let conviction = (z_score.abs() / 3.0).clamp(0.0, 1.0);
        
        AgentVote {
            agent: self.name(),
            direction,
            conviction,
            reasoning: format!("Z-score: {:.2}. ML Proxy suggests {:?}", z_score, direction),
        }
    }
}
