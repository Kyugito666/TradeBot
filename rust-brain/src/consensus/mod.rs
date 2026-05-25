// rust-brain/src/consensus/mod.rs
//
// Evaluates all 6 AgentVotes into a single ConsensusOutput.
//
// Algorithm:
//   1. Run VETO checks first (anomaly, vol crisis, extreme noise).
//      Any VETO → immediate WAIT, no trade.
//   2. Weighted conviction scoring: score = Σ weight_i × conviction_i × direction_sign_i
//   3. GBM bias adjustment (Physicist provides P5/P95 distribution skew).
//   4. Require min_agree agents agree on direction AND score >= min_confidence.
//   5. Return ConsensusOutput with full per-agent breakdown.

use crate::agents::{AgentVote, Direction};
use crate::shm::{MarketSnapshot, SignalOutput, AGENT_COUNT};
use chrono::Utc;

// ── Agent weights ────────────────────────────────────────────────────────────
// Sum = 1.00. Absurdist (new) gets 0.10 weight from existing allocations.
const WEIGHTS: [(&str, f64); AGENT_COUNT] = [
    ("mathematician", 0.28),
    ("physicist",     0.22),
    ("cryptographer", 0.20),
    ("linguist",      0.12),
    ("liquidator",    0.08),
    ("absurdist",     0.10),
];

// ── Thresholds ───────────────────────────────────────────────────────────────
const MIN_CONFIDENCE: f64 = 0.52;
const MIN_AGREE:      usize = 2;         // at least 2 agents must agree on direction
const NOISE_VETO:     f64  = 0.65;       // noise_ratio threshold from Mathematician
const GBM_BOOST:      f64  = 0.2;        // max GBM bias amplification factor

pub struct ConsensusEngine;

impl ConsensusEngine {
    pub fn evaluate(
        &self,
        votes:    &[AgentVote],
        snap:     &MarketSnapshot,
    ) -> SignalOutput {
        let ts_ms = Utc::now().timestamp_millis();

        // ── VETO CHAIN ───────────────────────────────────────────────────────
        if let Some(reason) = self.check_veto(votes, snap) {
            log::warn!("[Consensus] VETO: {reason}");
            return self.make_wait(votes, reason, ts_ms);
        }

        // ── Weighted Scoring ─────────────────────────────────────────────────
        let mut score      = 0.0_f64;
        let mut total_w    = 0.0_f64;
        let mut buy_count  = 0_usize;
        let mut sell_count = 0_usize;

        for vote in votes {
            let w = WEIGHTS.iter()
                .find(|(n, _)| *n == vote.agent)
                .map(|(_, w)| *w)
                .unwrap_or(0.05);

            let sign = match vote.direction {
                Direction::Buy  => { buy_count  += 1;  1.0 },
                Direction::Sell => { sell_count += 1; -1.0 },
                Direction::Wait => 0.0,
            };

            score   += w * vote.conviction * sign;
            total_w += w;
        }

        if total_w > 1e-10 { score /= total_w; }

        // ── GBM Bias Adjustment ──────────────────────────────────────────────
        // Physicist GBM upside_bias can boost confidence when distribution agrees.
        // We extract upside_bias from the physicist vote reasoning string.
        let gbm_bias = extract_gbm_bias(votes);
        if gbm_bias > 0.6 && score > 0.0 {
            score *= 1.0 + (gbm_bias - 0.5) * GBM_BOOST;
        } else if gbm_bias < 0.4 && score < 0.0 {
            score *= 1.0 + (0.5 - gbm_bias) * GBM_BOOST;
        }

        // ── Decision ─────────────────────────────────────────────────────────
        let confidence = score.abs().min(1.0);

        let action = if confidence >= MIN_CONFIDENCE {
            if score > 0.0 && buy_count  >= MIN_AGREE { Direction::Buy  }
            else if score < 0.0 && sell_count >= MIN_AGREE { Direction::Sell }
            else { Direction::Wait }
        } else {
            Direction::Wait
        };

        // ── TP / SL calculation ───────────────────────────────────────────────
        // Conservative: SL = recent low/high ± 0.5×ATR; TP = liquidation magnet or 1.5×ATR
        let atr    = snap.atr_14.max(snap.price * 0.001); // floor at 0.1% of price
        let price  = snap.price;

        let (entry, tp, sl) = match action {
            Direction::Buy => {
                let e  = price;
                let s  = price - atr * 1.5;
                // TP: nearest short cluster (liquidation magnet) or 2.5×ATR
                let t  = liq_tp_above(snap, price, atr).unwrap_or(price + atr * 2.5);
                (e, t, s)
            }
            Direction::Sell => {
                let e  = price;
                let s  = price + atr * 1.5;
                let t  = liq_tp_below(snap, price, atr).unwrap_or(price - atr * 2.5);
                (e, t, s)
            }
            Direction::Wait => (price, price, price),
        };

        let sl_dist = (entry - sl).abs().max(1e-8);
        let rr      = (tp - entry).abs() / sl_dist;

        // ── Build per-agent arrays ────────────────────────────────────────────
        let mut agent_dirs        = [0u8; AGENT_COUNT];
        let mut agent_convictions = [0.0f64; AGENT_COUNT];

        for (i, vote) in votes.iter().take(AGENT_COUNT).enumerate() {
            agent_dirs[i]        = vote.direction as u8;
            agent_convictions[i] = vote.conviction;
        }

        log::info!(
            "[Consensus] {:?} conf={:.3} BUY={buy_count} SELL={sell_count} score={score:.3} RR={rr:.2}",
            action, confidence
        );

        SignalOutput {
            action,
            confidence,
            entry,
            take_profit: tp,
            stop_loss:   sl,
            risk_reward: rr,
            veto:        false,
            veto_reason: String::new(),
            agent_dirs,
            agent_convictions,
            ts_ms,
        }
    }

    fn check_veto(&self, votes: &[AgentVote], snap: &MarketSnapshot) -> Option<String> {
        // Veto 1: Physicist reports volatility crisis
        if let Some(v) = votes.iter().find(|v| v.agent == "physicist") {
            if v.reasoning.contains("VOLATILITY CRISIS") {
                return Some(v.reasoning.clone());
            }
        }

        // Veto 2: Mathematician noise > threshold
        // We parse noise from reasoning string "noise=X.XXX"
        if let Some(v) = votes.iter().find(|v| v.agent == "mathematician") {
            if let Some(noise) = parse_f64_field(&v.reasoning, "noise=") {
                if noise > NOISE_VETO {
                    return Some(format!("Market noise {noise:.3} > threshold {NOISE_VETO}"));
                }
            }
            if v.reasoning.contains("anomaly=true") {
                return Some("Mathematical anomaly detected (|Z| > 4σ)".into());
            }
        }

        // Veto 3: Absurdist extreme squeeze (funding > 0.05% in one direction is dangerous)
        let abs_funding = snap.funding_rate.abs();
        if abs_funding > 0.0005 {
            // Extreme funding: only block if ALL other agents disagree with squeeze direction
            // (If they agree, the squeeze trade might still be valid — don't veto, just warn)
            log::warn!("[Consensus] High funding rate {:.4}% — Absurdist squeeze alert", abs_funding * 100.0);
        }

        None
    }

    fn make_wait(&self, votes: &[AgentVote], reason: String, ts_ms: i64) -> SignalOutput {
        let mut agent_dirs        = [0u8; AGENT_COUNT];
        let mut agent_convictions = [0.0f64; AGENT_COUNT];
        for (i, v) in votes.iter().take(AGENT_COUNT).enumerate() {
            agent_dirs[i]        = v.direction as u8;
            agent_convictions[i] = v.conviction;
        }
        SignalOutput {
            action: Direction::Wait, confidence: 0.0,
            entry: 0.0, take_profit: 0.0, stop_loss: 0.0, risk_reward: 0.0,
            veto: true, veto_reason: reason, agent_dirs, agent_convictions, ts_ms,
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

fn extract_gbm_bias(votes: &[AgentVote]) -> f64 {
    votes.iter()
        .find(|v| v.agent == "physicist")
        .and_then(|v| parse_f64_field(&v.reasoning, "upside_bias="))
        .unwrap_or(0.5)
}

fn parse_f64_field(s: &str, field: &str) -> Option<f64> {
    let pos = s.find(field)?;
    let rest = &s[pos + field.len()..];
    let end = rest.find(|c: char| c == ' ' || c == ',' || c == ']').unwrap_or(rest.len());
    rest[..end].parse::<f64>().ok()
}

fn liq_tp_above(snap: &MarketSnapshot, price: f64, atr: f64) -> Option<f64> {
    // Estimate nearest short-liq cluster above current price within 5×ATR
    let look_range = atr * 5.0;
    let total_vol: f64 = snap.candles.iter().map(|c| c.vol).sum();
    if total_vol < 1.0 { return None; }

    let oi_usd = snap.oi * price;
    let lsr    = snap.lsr.max(1e-6);
    let short_frac = 1.0 / (1.0 + lsr);

    let mut candidates: Vec<f64> = Vec::new();
    for candle in &snap.candles {
        let vwap = (candle.high + candle.low + candle.close) / 3.0;
        for &lev in &[10.0_f64, 20.0, 25.0] { // most common tiers
            let short_liq = vwap * (1.0 + 1.0/lev - 0.004);
            if short_liq > price && (short_liq - price) < look_range {
                candidates.push(short_liq);
            }
        }
    }

    if candidates.is_empty() { None } else {
        candidates.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
        Some(candidates[candidates.len() / 4]) // pick 25th percentile = nearest dense
    }
}

fn liq_tp_below(snap: &MarketSnapshot, price: f64, atr: f64) -> Option<f64> {
    let look_range = atr * 5.0;
    let mut candidates: Vec<f64> = Vec::new();
    for candle in &snap.candles {
        let vwap = (candle.high + candle.low + candle.close) / 3.0;
        for &lev in &[10.0_f64, 20.0, 25.0] {
            let long_liq = vwap * (1.0 - 1.0/lev + 0.004);
            if long_liq < price && (price - long_liq) < look_range {
                candidates.push(long_liq);
            }
        }
    }
    if candidates.is_empty() { None } else {
        candidates.sort_unstable_by(|a, b| b.partial_cmp(a).unwrap());
        Some(candidates[candidates.len() / 4])
    }
}
