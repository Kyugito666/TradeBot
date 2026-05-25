// rust-brain/src/agents/mathematician.rs
//
// Port of agent_mathematician.py — Bayesian probability chain over technical indicators.
// Evidence chain: RSI (momentum) → Z-score (mean reversion) → noise ratio (veto).

use super::{bayesian_update, closes, highs, lows, rsi, zscore, wilder_atr, Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct MathematicianAgent {
    period:     usize,
    rsi_period: usize,
}

impl Default for MathematicianAgent {
    fn default() -> Self { Self { period: 14, rsi_period: 14 } }
}

impl Agent for MathematicianAgent {
    fn name(&self) -> &'static str { "mathematician" }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let c = closes(snap);
        let h = highs(snap);
        let l = lows(snap);

        if c.len() < self.period * 2 {
            return AgentVote::wait("mathematician", "insufficient candles");
        }

        // ── Evidence 1: RSI (momentum) ───────────────────────────────────────
        let rsi_val = rsi(&c, self.rsi_period);
        let mut prob_up = 0.5_f64;

        if rsi_val < 30.0 {
            // Oversold → strong likelihood of reversal up
            prob_up = bayesian_update(prob_up, 0.72, 0.28);
        } else if rsi_val < 45.0 {
            prob_up = bayesian_update(prob_up, 0.57, 0.43);
        } else if rsi_val > 70.0 {
            // Overbought → likelihood of reversal down
            prob_up = bayesian_update(prob_up, 0.28, 0.72);
        } else if rsi_val > 55.0 {
            prob_up = bayesian_update(prob_up, 0.43, 0.57);
        }

        // ── Evidence 2: Z-score (mean reversion) ─────────────────────────────
        let z = zscore(&c, self.period);

        if z < -2.0 {
            prob_up = bayesian_update(prob_up, 0.68, 0.32);
        } else if z < -1.0 {
            prob_up = bayesian_update(prob_up, 0.58, 0.42);
        } else if z > 2.0 {
            prob_up = bayesian_update(prob_up, 0.32, 0.68);
        } else if z > 1.0 {
            prob_up = bayesian_update(prob_up, 0.42, 0.58);
        }

        let prob_down = 1.0 - prob_up;

        // ── Noise ratio (veto trigger in consensus) ───────────────────────────
        let atr       = wilder_atr(&h, &l, &c, self.period);
        let body_last = (c.last().unwrap() - snap.candles.last().unwrap().open).abs();
        let range_last = snap.candles.last().map(|c| c.high - c.low).unwrap_or(1.0);
        let noise_ratio = if range_last > 1e-9 {
            (range_last - body_last) / range_last
        } else { 0.0 };

        // Anomaly: price z-score > 4σ
        let anomaly = z.abs() > 4.0;

        let (dir, conviction) = if prob_up > 0.62 {
            (Direction::Buy,  prob_up)
        } else if prob_down > 0.62 {
            (Direction::Sell, prob_down)
        } else {
            (Direction::Wait, 0.5)
        };

        AgentVote {
            agent:      "mathematician",
            direction:  dir,
            conviction,
            reasoning:  format!(
                "RSI={:.1} Z={:.2} P(up)={:.3} P(dn)={:.3} noise={:.2} anomaly={anomaly} ATR={:.4}",
                rsi_val, z, prob_up, prob_down, noise_ratio, atr
            ),
        }
    }
}

// Expose noise_ratio and anomaly for consensus veto checks
pub fn compute_veto_fields(snap: &MarketSnapshot) -> (f64, bool) {
    let c = closes(snap);
    let h = highs(snap);
    let l = lows(snap);
    if c.len() < 14 { return (0.0, false); }

    let z           = zscore(&c, 14);
    let body        = (c.last().unwrap() - snap.candles.last().unwrap().open).abs();
    let range       = snap.candles.last().map(|c| c.high - c.low).unwrap_or(1.0);
    let noise_ratio = if range > 1e-9 { (range - body) / range } else { 0.0 };
    let anomaly     = z.abs() > 4.0;
    (noise_ratio, anomaly)
}
