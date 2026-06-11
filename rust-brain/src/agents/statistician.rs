// agents/statistician.rs — Enhanced with Quant Microstructure + Mean Reversion
//
// [Fase 10B] Now uses:
// - Hurst exponent for regime detection (mean-reverting vs trending)
// - Bollinger squeeze for volatility contraction breakouts
// - Tick microstructure (flow imbalance, Kyle's lambda) for HFT edge
// - Original LSR/Funding analysis preserved

use super::{Agent, AgentVote, Direction, closes, highs, lows};
use crate::shm::MarketSnapshot;
use crate::quant::microstructure;
use crate::quant::mean_reversion;

pub struct Statistician;

impl Agent for Statistician {
    fn name(&self) -> &'static str {
        "statistician"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        if snap.candles.is_empty() {
            return AgentVote::forced_choice(self.name(), 0.1, 0.1, "No data");
        }

        let c = closes(snap);
        let _h = highs(snap);
        let _l = lows(snap);

        // ── 1. Original LSR/Funding stat-arb signal ──────────────────────
        let lsr = snap.lsr;
        let funding = snap.funding_rate;

        let mut base_conviction = 0.0_f64;
        let mut base_dir = Direction::Veto;

        if lsr > 1.2 && funding > 0.0001 {
            base_dir = Direction::Sell;
            base_conviction = 0.7;
        } else if lsr < 0.8 && funding < -0.0001 {
            base_dir = Direction::Buy;
            base_conviction = 0.7;
        } else if lsr > 1.05 {
            base_dir = Direction::Buy;
            base_conviction = 0.3;
        } else if lsr < 0.95 {
            base_dir = Direction::Sell;
            base_conviction = 0.3;
        }

        // ── 2. Hurst Exponent — regime detection ─────────────────────────
        let hurst = mean_reversion::hurst_exponent(&c);
        let regime = if hurst < 0.4 { "mean_revert" }
                     else if hurst > 0.6 { "trending" }
                     else { "random" };

        // ── 3. Bollinger Squeeze — volatility contraction ────────────────
        let bb = mean_reversion::bollinger_bands(&c, 20, 2.0);
        let squeeze_signal = if bb.squeeze {
            // Squeeze detected — breakout imminent
            if bb.percent_b > 0.8 { "squeeze_bull" }
            else if bb.percent_b < 0.2 { "squeeze_bear" }
            else { "squeeze_neutral" }
        } else { "no_squeeze" };

        // ── 4. Tick Microstructure (HFT) ─────────────────────────────────
        let micro = microstructure::analyze_ticks(&snap.raw_ticks);

        // ── 5. Combine signals ───────────────────────────────────────────
        let mut final_dir = base_dir;
        let mut final_conv = base_conviction;

        // Hurst boost: if regime confirms direction, boost conviction
        if regime == "trending" && base_conviction > 0.0 {
            final_conv = (final_conv + 0.15).min(1.0);
        } else if regime == "mean_revert" && base_conviction > 0.0 {
            // Mean-reverting regime: flip if following trend
            if base_dir == Direction::Buy && bb.percent_b > 0.8 {
                final_dir = Direction::Sell;
                final_conv = 0.6;
            } else if base_dir == Direction::Sell && bb.percent_b < 0.2 {
                final_dir = Direction::Buy;
                final_conv = 0.6;
            }
        }

        // Squeeze breakout: override if strong squeeze
        if bb.squeeze && bb.squeeze_intensity < 0.5 {
            if micro.flow_imbalance > 0.3 {
                final_dir = Direction::Buy;
                final_conv = (final_conv + 0.2).min(1.0);
            } else if micro.flow_imbalance < -0.3 {
                final_dir = Direction::Sell;
                final_conv = (final_conv + 0.2).min(1.0);
            }
        }

        // Kyle's Lambda: high impact = reduce conviction (illiquid)
        if micro.kyle_lambda.abs() > 0.001 && micro.tick_count > 5 {
            final_conv *= 0.85; // Penalize illiquid markets
        }

        AgentVote {
            agent: self.name(),
            direction: final_dir,
            conviction: final_conv,
            reasoning: format!(
                "LSR={:.2} FR={:.4} H={:.2}({}) BB%={:.2} sq={} flow={:+.2} λ={:.5}",
                lsr, funding, hurst, regime, bb.percent_b, squeeze_signal,
                micro.flow_imbalance, micro.kyle_lambda
            ),
        }
    }
}
