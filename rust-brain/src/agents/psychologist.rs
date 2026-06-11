use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct Psychologist;

impl Agent for Psychologist {
    fn name(&self) -> &'static str {
        "psychologist"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let sentiment = snap.sentiment_score; // -1.0 to 1.0
        let news_volume = snap.news_count as f64;

        if news_volume == 0.0 || sentiment.abs() < 0.1 {
            return AgentVote::forced_choice(self.name(), 0.1, 0.1, "Neutral or no sentiment data");
        }

        let mut conviction = (sentiment.abs() as f64).clamp(0.0, 1.0);
        let direction = if sentiment > 0.0 {
            Direction::Buy
        } else {
            Direction::Sell
        };

        // Increase conviction if news volume is high
        if news_volume > 10.0 {
            conviction = (conviction + 0.2).clamp(0.0, 1.0);
        }

        AgentVote {
            agent: self.name(),
            direction,
            conviction,
            reasoning: format!("Sentiment: {:.2} from {} sources. Market psychology is {:?}", sentiment, news_volume, direction),
        }
    }
}
