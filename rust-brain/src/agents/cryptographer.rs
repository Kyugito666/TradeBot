// rust-brain/src/agents/cryptographer.rs
//
// Port of agent_cryptographer.py — Pattern recognition + Order Flow analysis.
// Without a serialised ML model available at startup, falls back to a rule-based
// ensemble that faithfully replicate the Python agent's fallback path.
// To enable the ML path: drop a `pattern_model.bin` into `ml_models/` and
// uncomment the inference block (requires linfa or ONNX runtime crate).

use super::{volumes, Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct CryptographerAgent;

impl Agent for CryptographerAgent {
    fn name(&self) -> &'static str { "cryptographer" }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let n = snap.candles.len();
        if n < 50 {
            return AgentVote::wait("cryptographer", "insufficient candles");
        }

        let candles = &snap.candles;

        // ── 1. Volume Profile — Point of Control (POC) ───────────────────────
        let poc = {
            let min_price = candles.iter().map(|c| c.low).fold(f64::MAX, f64::min);
            let max_price = candles.iter().map(|c| c.high).fold(f64::MIN, f64::max);
            let bins      = 50_usize;
            let bin_w     = (max_price - min_price) / bins as f64;
            if bin_w < 1e-10 { snap.price } else {
                let mut hist = vec![0.0_f64; bins];
                for c in candles {
                    let idx = (((c.close - min_price) / bin_w) as usize).min(bins - 1);
                    hist[idx] += c.vol;
                }
                let max_idx = hist.iter().enumerate().max_by(|a,b| a.1.partial_cmp(b.1).unwrap()).map(|(i,_)| i).unwrap_or(0);
                min_price + (max_idx as f64 + 0.5) * bin_w
            }
        };

        // ── 2. Cumulative Volume Delta (CVD) — Order Flow ────────────────────
        let window  = 20;
        let recent  = &candles[n.saturating_sub(window)..];
        let cvd: f64 = recent.iter().map(|c| {
            if c.close > c.open { c.vol } else if c.close < c.open { -c.vol } else { 0.0 }
        }).sum();

        // ── 3. Whale Footprint (z-score volume spike) ─────────────────────────
        let vols     = volumes(snap);
        let last_vol = *vols.last().unwrap_or(&0.0);
        let hist_vol = &vols[..vols.len().saturating_sub(1)];
        let mean_vol = hist_vol.iter().sum::<f64>() / hist_vol.len() as f64;
        let std_vol  = {
            let v = hist_vol.iter().map(|x|(x-mean_vol).powi(2)).sum::<f64>() / hist_vol.len() as f64;
            v.sqrt()
        };
        let vol_z          = if std_vol > 1e-10 { (last_vol - mean_vol) / std_vol } else { 0.0 };
        let whale_present  = vol_z > 2.5;
        let last_c         = candles.last().unwrap();
        let whale_dir      = if whale_present {
            if last_c.close > last_c.open { 1i8 } else { -1i8 }
        } else { 0i8 };

        // ── 4. Candlestick Pattern Detection ─────────────────────────────────
        let last      = &candles[n-1];
        let prev      = &candles[n-2];
        let range_l   = last.high - last.low;
        let body_l    = (last.close - last.open).abs();
        let body_ratio = if range_l > 1e-10 { body_l / range_l } else { 0.0 };

        let is_bullish_engulf = last.close >  last.open
            && last.open  <  prev.close
            && last.close >  prev.open
            && prev.close <  prev.open;

        let is_bearish_engulf = last.close <  last.open
            && last.open  >  prev.close
            && last.close <  prev.open
            && prev.close >  prev.open;

        let is_doji = body_ratio < 0.1;

        // ── 5. Rule-Based Scoring (ML fallback) ──────────────────────────────
        let mut score: f64 = 0.0;

        if is_bullish_engulf {
            score += 0.35;
            if cvd > 0.0 { score += 0.15; } // CVD confirmation
        }
        if is_bearish_engulf {
            score -= 0.35;
            if cvd < 0.0 { score -= 0.15; }
        }
        if is_doji { score *= 0.5; } // Doji = indecision, halve conviction

        // CVD directional push
        let cvd_norm = if mean_vol > 1e-10 { cvd / (mean_vol * window as f64) } else { 0.0 };
        score += cvd_norm.clamp(-0.3, 0.3);

        // Whale amplification
        if whale_present {
            score *= 1.0 + (vol_z / 5.0).min(0.5);
            if whale_dir < 0 { score = score.min(-score.abs()); }
            if whale_dir > 0 { score = score.max( score.abs()); }
        }

        // POC proximity boost (price near POC = high-conviction zone)
        let poc_dist_pct = ((snap.price - poc) / poc.max(1.0)).abs();
        if poc_dist_pct < 0.005 { score *= 1.1; }

        let score = score.clamp(-1.0, 1.0);

        let pattern = if is_bullish_engulf { "BullishEngulfing" }
                      else if is_bearish_engulf { "BearishEngulfing" }
                      else if is_doji { "Doji" }
                      else { "None" };

        let (dir, conv) = if score > 0.25 {
            (Direction::Buy,  score.abs())
        } else if score < -0.25 {
            (Direction::Sell, score.abs())
        } else {
            (Direction::Wait, 0.5)
        };

        AgentVote {
            agent:      "cryptographer",
            direction:  dir,
            conviction: conv,
            reasoning:  format!(
                "Pattern={pattern} CVD={cvd:.0} WhalZ={vol_z:.1} WhalDir={whale_dir} POC={poc:.2} score={score:.3}"
            ),
        }
    }
}
