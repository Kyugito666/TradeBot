// agents/data_scientist.rs — Enhanced with Quant Momentum Signals
//
// [Fase 10B] Now uses:
// - Multi-timeframe momentum (short/mid/long ROC)
// - Volume-weighted momentum for confirmation
// - Fisher Transform for precise turning points
// - Momentum divergence detector
// - Original Z-score analysis preserved

use super::{Agent, AgentVote, Direction, closes, volumes};
use crate::shm::MarketSnapshot;
use crate::quant::momentum;

pub struct DataScientist;

impl Agent for DataScientist {
    fn name(&self) -> &'static str {
        "data_scientist"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        if snap.candles.is_empty() {
            return AgentVote::forced_choice(self.name(), 0.1, 0.1, "No data");
        }

        let c = closes(snap);
        let v = volumes(snap);

        // ── 1. Original Z-score analysis ─────────────────────────────────
        let len = c.len();
        let recent = len.min(10);
        let mean: f64 = c[len - recent..].iter().sum::<f64>() / recent as f64;
        let var: f64 = c[len - recent..].iter().map(|x| (x - mean).powi(2)).sum::<f64>() / recent as f64;
        let std_dev = var.sqrt();
        let z_score = if std_dev > 0.0 { (snap.price - mean) / std_dev } else { 0.0 };

        // ── 2. Multi-TF Momentum ─────────────────────────────────────────
        let (short_mom, mid_mom, long_mom, composite_mom) = momentum::multi_tf_momentum(&c);

        // ── 3. Volume-Weighted Momentum ──────────────────────────────────
        let vwm = momentum::volume_weighted_momentum(&c, &v, 14);

        // ── 4. Fisher Transform — turning point detection ────────────────
        let (fisher, fisher_prev) = momentum::fisher_transform(&c, 10);
        let fisher_cross_up = fisher > fisher_prev && fisher_prev < -1.0;
        let fisher_cross_down = fisher < fisher_prev && fisher_prev > 1.0;

        // ── 5. Divergence Detection ──────────────────────────────────────
        let (bull_div, bear_div) = momentum::detect_divergence(&c, 20);

        // ── 6. Chande Momentum Oscillator ────────────────────────────────
        let cmo = momentum::cmo(&c, 14);

        // ── Combine all signals ──────────────────────────────────────────
        let mut score = 0.0_f64; // Positive = bullish, negative = bearish

        // Z-score contribution
        if z_score > 2.0 { score -= 0.3; }       // Overbought → sell
        else if z_score < -2.0 { score += 0.3; }  // Oversold → buy
        else if z_score > 0.5 { score += 0.1; }   // Mild trend up
        else if z_score < -0.5 { score -= 0.1; }  // Mild trend down

        // Composite momentum
        if composite_mom > 2.0 { score += 0.25; }
        else if composite_mom < -2.0 { score -= 0.25; }
        else if composite_mom > 0.5 { score += 0.1; }
        else if composite_mom < -0.5 { score -= 0.1; }

        // Volume-weighted momentum (strong confirmation)
        if vwm > 3.0 { score += 0.2; }
        else if vwm < -3.0 { score -= 0.2; }

        // Fisher crossover (precise timing)
        if fisher_cross_up { score += 0.3; }
        if fisher_cross_down { score -= 0.3; }

        // Divergence (reversal warning)
        if bull_div { score += 0.25; }
        if bear_div { score -= 0.25; }

        // CMO extreme
        if cmo > 50.0 { score -= 0.1; } // Overbought
        else if cmo < -50.0 { score += 0.1; } // Oversold

        // ── Final decision ───────────────────────────────────────────────
        let (direction, conviction) = if score > 0.3 {
            (Direction::Buy, score.min(1.0))
        } else if score < -0.3 {
            (Direction::Sell, score.abs().min(1.0))
        } else {
            (Direction::Veto, 0.3)
        };

        AgentVote {
            agent: self.name(),
            direction,
            conviction,
            reasoning: format!(
                "Z={:.2} mom={:.1}/{:.1}/{:.1} vwm={:.1} fisher={:.2} cmo={:.0} div=B{}/R{} score={:+.2}",
                z_score, short_mom, mid_mom, long_mom, vwm, fisher, cmo,
                bull_div as u8, bear_div as u8, score
            ),
        }
    }
}
