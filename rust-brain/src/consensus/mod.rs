// rust-brain/src/consensus/mod.rs

use crate::agents::{AgentVote, Direction};
use crate::shm::{MarketSnapshot, SignalOutput, AGENT_COUNT};
use chrono::Utc;
use std::sync::OnceLock;

const WEIGHTS: [(&str, f64); AGENT_COUNT] = [
    ("mathematician", 0.28),
    ("physicist",     0.22),
    ("cryptographer", 0.20),
    ("linguist",      0.12),
    ("liquidator",    0.08),
    ("absurdist",     0.10),
];

const NOISE_VETO: f64 = 0.65;
const GBM_BOOST:  f64 = 0.2;

struct StyleConfig {
    min_confidence: f64,
    min_agree:      usize,
    tp_atr_mult:    f64,
    sl_atr_mult:    f64,
}

// Membaca Trading Style dari .env dan merekalibrasi semua parameter agen
fn get_style() -> &'static StyleConfig {
    static STYLE: OnceLock<StyleConfig> = OnceLock::new();
    STYLE.get_or_init(|| {
        let mut style_name = String::from("scalping");
        if let Ok(content) = std::fs::read_to_string(".env") {
            for line in content.lines() {
                let line = line.trim();
                if line.starts_with("TRADING_STYLE=") {
                    style_name = line["TRADING_STYLE=".len()..].trim_matches('"').to_lowercase();
                }
            }
        }
        match style_name.as_str() {
            "scalping"   => StyleConfig { min_confidence: 0.35, min_agree: 2, tp_atr_mult: 1.0, sl_atr_mult: 0.8 },
            "daytrading" => StyleConfig { min_confidence: 0.50, min_agree: 3, tp_atr_mult: 2.0, sl_atr_mult: 1.2 },
            _            => StyleConfig { min_confidence: 0.65, min_agree: 4, tp_atr_mult: 3.5, sl_atr_mult: 1.5 }, // swing default
        }
    })
}

pub struct ConsensusEngine;

impl ConsensusEngine {
    pub fn evaluate(&self, votes: &[AgentVote], snap: &MarketSnapshot) -> SignalOutput {
        let ts_ms = Utc::now().timestamp_millis();
        let cfg   = get_style();

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
            let w = WEIGHTS.iter().find(|(n, _)| *n == vote.agent).map(|(_, w)| *w).unwrap_or(0.05);
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
        let gbm_bias = extract_gbm_bias(votes);
        if gbm_bias > 0.6 && score > 0.0 { score *= 1.0 + (gbm_bias - 0.5) * GBM_BOOST; }
        else if gbm_bias < 0.4 && score < 0.0 { score *= 1.0 + (0.5 - gbm_bias) * GBM_BOOST; }

        let confidence = score.abs().min(1.0);

        // ── Decision Tree Dinamis ────────────────────────────────────────────
        let action = if confidence >= cfg.min_confidence {
            if score > 0.0 && buy_count  >= cfg.min_agree { Direction::Buy  }
            else if score < 0.0 && sell_count >= cfg.min_agree { Direction::Sell }
            else { Direction::Wait }
        } else {
            Direction::Wait
        };

        // ── TP/SL Calculation (Adaptif terhadap Style) ────────────────────────
        let atr   = snap.atr_14.max(snap.price * 0.001);
        let price = snap.price;

        let (entry, tp, sl) = match action {
            Direction::Buy => {
                let e = price;
                let s = price - atr * cfg.sl_atr_mult;
                let t = liq_tp_above(snap, price, atr, cfg.tp_atr_mult * 1.5).unwrap_or(price + atr * cfg.tp_atr_mult);
                (e, t, s)
            }
            Direction::Sell => {
                let e = price;
                let s = price + atr * cfg.sl_atr_mult;
                let t = liq_tp_below(snap, price, atr, cfg.tp_atr_mult * 1.5).unwrap_or(price - atr * cfg.tp_atr_mult);
                (e, t, s)
            }
            Direction::Wait => (price, price, price),
        };

        let sl_dist = (entry - sl).abs().max(1e-8);
        let rr      = (tp - entry).abs() / sl_dist;

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
            action, confidence, entry, take_profit: tp, stop_loss: sl,
            risk_reward: rr, veto: false, veto_reason: String::new(),
            agent_dirs, agent_convictions, ts_ms,
        }
    }

    fn check_veto(&self, votes: &[AgentVote], snap: &MarketSnapshot) -> Option<String> {
        if let Some(v) = votes.iter().find(|v| v.agent == "physicist") {
            if v.reasoning.contains("VOLATILITY CRISIS") { return Some(v.reasoning.clone()); }
        }
        if let Some(v) = votes.iter().find(|v| v.agent == "mathematician") {
            if let Some(noise) = parse_f64_field(&v.reasoning, "noise=") {
                if noise > NOISE_VETO { return Some(format!("Market noise {noise:.3} > threshold {NOISE_VETO}")); }
            }
            if v.reasoning.contains("anomaly=true") { return Some("Mathematical anomaly detected (|Z| > 4σ)".into()); }
        }
        None
    }

    fn make_wait(&self, votes: &[AgentVote], reason: String, ts_ms: i64) -> SignalOutput {
        let mut agent_dirs = [0u8; AGENT_COUNT];
        let mut agent_convictions = [0.0f64; AGENT_COUNT];
        for (i, v) in votes.iter().take(AGENT_COUNT).enumerate() {
            agent_dirs[i] = v.direction as u8;
            agent_convictions[i] = v.conviction;
        }
        SignalOutput {
            action: Direction::Wait, confidence: 0.0,
            entry: 0.0, take_profit: 0.0, stop_loss: 0.0, risk_reward: 0.0,
            veto: true, veto_reason: reason, agent_dirs, agent_convictions, ts_ms,
        }
    }
}

fn extract_gbm_bias(votes: &[AgentVote]) -> f64 {
    votes.iter().find(|v| v.agent == "physicist")
        .and_then(|v| parse_f64_field(&v.reasoning, "upside_bias=")).unwrap_or(0.5)
}

fn parse_f64_field(s: &str, field: &str) -> Option<f64> {
    let pos = s.find(field)?;
    let rest = &s[pos + field.len()..];
    let end = rest.find(|c: char| c == ' ' || c == ',' || c == ']').unwrap_or(rest.len());
    rest[..end].parse::<f64>().ok()
}

fn liq_tp_above(snap: &MarketSnapshot, price: f64, atr: f64, look_mult: f64) -> Option<f64> {
    let look_range = atr * look_mult;
    let total_vol: f64 = snap.candles.iter().map(|c| c.vol).sum();
    if total_vol < 1.0 { return None; }

    let mut candidates: Vec<f64> = Vec::new();
    for candle in &snap.candles {
        let vwap = (candle.high + candle.low + candle.close) / 3.0;
        for &lev in &[10.0_f64, 20.0, 25.0] {
            let short_liq = vwap * (1.0 + 1.0/lev - 0.004);
            if short_liq > price && (short_liq - price) < look_range {
                candidates.push(short_liq);
            }
        }
    }
    if candidates.is_empty() { None } else {
        candidates.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
        Some(candidates[candidates.len() / 4]) 
    }
}

fn liq_tp_below(snap: &MarketSnapshot, price: f64, atr: f64, look_mult: f64) -> Option<f64> {
    let look_range = atr * look_mult;
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
