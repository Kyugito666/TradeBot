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

        // ── Regime Filter (Kaufman Efficiency Ratio) ──────────────────────────
        let mut er = 0.0;
        let n = self.period.min(c.len() - 1);
        if n > 0 {
            let change = (c.last().unwrap() - c[c.len() - 1 - n]).abs();
            let mut vol = 0.0;
            for i in (c.len() - n)..c.len() {
                vol += (c[i] - c[i - 1]).abs();
            }
            if vol > 1e-9 {
                er = change / vol;
            }
        }
        
        let is_strong_uptrend = er > 0.35 && c.last().unwrap() > &c[c.len() - 1 - n];
        let is_strong_downtrend = er > 0.35 && c.last().unwrap() < &c[c.len() - 1 - n];

        // ── Evidence 1: RSI (momentum) ───────────────────────────────────────
        let rsi_val = rsi(&c, self.rsi_period);
        let mut prob_up = 0.5_f64;

        if is_strong_uptrend {
            // Trend-following logic
            if rsi_val > 65.0 {
                prob_up = bayesian_update(prob_up, 0.75, 0.25); // Breakout momentum
            } else if rsi_val < 50.0 {
                prob_up = bayesian_update(prob_up, 0.65, 0.35); // Buy the dip
            }
        } else if is_strong_downtrend {
            if rsi_val < 35.0 {
                prob_up = bayesian_update(prob_up, 0.25, 0.75); // Breakdown momentum
            } else if rsi_val > 50.0 {
                prob_up = bayesian_update(prob_up, 0.35, 0.65); // Sell the rip
            }
        } else {
            // Ranging market -> Mean Reversion logic
            if rsi_val < 30.0 {
                prob_up = bayesian_update(prob_up, 0.72, 0.28);
            } else if rsi_val < 45.0 {
                prob_up = bayesian_update(prob_up, 0.57, 0.43);
            } else if rsi_val > 70.0 {
                prob_up = bayesian_update(prob_up, 0.28, 0.72);
            } else if rsi_val > 55.0 {
                prob_up = bayesian_update(prob_up, 0.43, 0.57);
            }
        }

        // ── Evidence 2: Z-score (mean reversion vs momentum) ─────────────────
        let z = zscore(&c, self.period);

        if is_strong_uptrend {
            if z > 1.5 {
                prob_up = bayesian_update(prob_up, 0.65, 0.35); // Strong upside momentum
            }
        } else if is_strong_downtrend {
            if z < -1.5 {
                prob_up = bayesian_update(prob_up, 0.35, 0.65); // Strong downside momentum
            }
        } else {
            if z < -2.0 {
                prob_up = bayesian_update(prob_up, 0.68, 0.32);
            } else if z < -1.0 {
                prob_up = bayesian_update(prob_up, 0.58, 0.42);
            } else if z > 2.0 {
                prob_up = bayesian_update(prob_up, 0.32, 0.68);
            } else if z > 1.0 {
                prob_up = bayesian_update(prob_up, 0.42, 0.58);
            }
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
