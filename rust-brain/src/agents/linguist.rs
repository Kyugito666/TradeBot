// rust-brain/src/agents/linguist.rs
//
// Port of agent_linguist.py — Social Sentiment Analysis.
//
// In the Go+Rust architecture, Rust has no network access.
// The Go gateway runs a lightweight RSS scraper goroutine every 5 min
// and writes the aggregated sentiment_score + news_count into SHM.
// This agent simply reads that cache — O(1) cost, never blocks.

use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct LinguistAgent;

impl Agent for LinguistAgent {
    fn name(&self) -> &'static str { "linguist" }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let score = snap.sentiment_score as f64;
        let count = snap.news_count;

        if count == 0 {
            return AgentVote::forced_choice("linguist", 0.1, 0.1, "no news data in SHM cache yet");
        }

        // Confidence grows with article count, capped at 1.0
        // Halve it when we have few articles (noisy signal)
        let base_conf = (count as f64 / 10.0).min(1.0);

        // Map score → label
        let (label, dir, conviction) = if score > 0.4 {
            ("VERY_BULLISH", Direction::Buy,  base_conf)
        } else if score > 0.1 {
            ("BULLISH",      Direction::Buy,  base_conf * 0.75)
        } else if score < -0.4 {
            ("VERY_BEARISH", Direction::Sell, base_conf)
        } else if score < -0.1 {
            ("BEARISH",      Direction::Sell, base_conf * 0.75)
        } else {
            ("NEUTRAL",      Direction::Veto, base_conf * 0.3)
        };

        AgentVote {
            agent:      "linguist",
            direction:  dir,
            conviction,
            reasoning:  format!(
                "sentiment={score:.3} label={label} articles={count} conf={conviction:.3}"
            ),
        }
    }
}
