// rust-brain/src/consensus/mod.rs
//
// [FIX-NOISE-SCALP] noise_veto 0.82 → 0.93 — log: noise=0.860 → veto terus
// [FIX-CONF-SCALP]  min_confidence 0.18 → 0.12, min_rr 1.2 → 0.8
// [FIX-NOISE-DAY]   noise_veto 0.68 → 0.78
// [FIX-NOISE-SWING] noise_veto 0.55 → 0.65
// [FIX-CONF]        baca bot_runtime.conf bukan .env (sudah ada, dipertahankan)

use crate::agents::{AgentVote, Direction};
use crate::shm::{MarketSnapshot, SignalOutput, AGENT_COUNT};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Mutex;
use std::fs;

const WEIGHTS: [(&str, f64); 9] = [
    ("mathematician", 0.25),
    ("physicist",     0.20),
    ("cryptographer", 0.15),
    ("linguist",      0.10),
    ("liquidator",    0.10),
    ("absurdist",     0.10),
    ("game_theorist", 0.15),
    ("economist",     0.15),
    ("data_engineer", 0.0), // gatekeeper, no weight
];

const ABSURDIST_DAMP: f64 = 0.30;
const LINGUIST_DAMP:  f64 = 0.50;

#[derive(Debug, Clone)]
struct StyleConfig {
    style_name:     String,
    min_confidence: f64,
    min_agree:      usize,
    tp_atr_mult:    f64,
    sl_atr_mult:    f64,
    noise_veto:     f64,
    min_rr:         f64,
}

fn read_trading_style() -> String {
    for filename in &["bot_runtime.conf", ".env"] {
        if let Ok(content) = std::fs::read_to_string(filename) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if line.starts_with("TRADING_STYLE=") {
                    let val = line["TRADING_STYLE=".len()..]
                        .trim().trim_matches('"').trim_matches('\'')
                        .to_lowercase();
                    if !val.is_empty() { return val; }
                }
            }
        }
    }
    "scalping".to_string()
}

fn make_style_config(style_name: &str) -> StyleConfig {
    match style_name {
        "scalping" => StyleConfig {
            style_name:     style_name.to_string(),
            min_confidence: 0.20,   // increased to 0.35 to reduce false signals -> Relaxed to 0.20 for more signals
            min_agree:      1,      // was 2, relaxed to 1
            tp_atr_mult:    1.2,    // increased TP distance -> Relaxed to 1.2
            sl_atr_mult:    1.0,    // wider SL to avoid stop hunts
            noise_veto:     1.50,   // stricter noise threshold -> Relaxed to 1.50
            min_rr:         1.0,    // was 1.2
        },
        "daytrading" | "daytrade" | "day" => StyleConfig {
            style_name:     style_name.to_string(),
            min_confidence: 0.25,
            min_agree:      2,
            tp_atr_mult:    2.0,
            sl_atr_mult:    1.2,
            noise_veto:     1.20,   // [FIX-NOISE-DAY] was 0.78, relaxed to 1.20
            min_rr:         1.2,
        },
        "swing" | "sniper" | "sniper_swing" => StyleConfig {
            style_name:     style_name.to_string(),
            min_confidence: 0.30,
            min_agree:      2,
            tp_atr_mult:    3.0,
            sl_atr_mult:    1.5,
            noise_veto:     1.00,   // [FIX-NOISE-SWING] was 0.65, relaxed to 1.00
            min_rr:         1.5,
        },
        _ => {
            log::warn!("[Consensus] Unknown TRADING_STYLE='{style_name}', using scalping defaults");
            StyleConfig {
                style_name:     style_name.to_string(),
                min_confidence: 0.12,
                min_agree:      1,
                tp_atr_mult:    1.0,
                sl_atr_mult:    0.6,
                noise_veto:     1.50,
                min_rr:         0.8,
            }
        }
    }
}

fn calc_ema(closes: &[f64], period: usize) -> f64 {
    if closes.is_empty() { return 0.0; }
    if closes.len() < period {
        return closes.iter().sum::<f64>() / closes.len() as f64;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = closes[..period].iter().sum::<f64>() / period as f64;
    for &c in &closes[period..] { ema = c * k + ema * (1.0 - k); }
    ema
}

fn ema_alignment(snap: &MarketSnapshot) -> (f64, f64, f64, bool, bool) {
    let closes: Vec<f64> = snap.candles.iter().map(|c| c.close).collect();
    if closes.len() < 50 {
        return (snap.price, snap.price, snap.price, false, false);
    }
    let ema9  = calc_ema(&closes, 9);
    let ema21 = calc_ema(&closes, 21);
    let ema50 = calc_ema(&closes, 50);
    let bear  = ema9 < ema21 && ema21 < ema50;
    let bull  = ema9 > ema21 && ema21 > ema50;
    (ema9, ema21, ema50, bear, bull)
}

#[derive(Debug)]
enum QuantVetoResult {
    Clear,
    Hard(String),
    Soft(f64),
}

#[derive(Debug, Clone)]
struct ActiveTrade {
    entry_price: f64,
    tp: f64,
    sl: f64,
    direction: Direction,
    agent_votes: Vec<(String, Direction, f64)>, // (agent_name, vote, conviction)
    status: String, // "PENDING" or "OPEN"
}

pub struct ConsensusEngine {
    active_trade: Mutex<Option<ActiveTrade>>,
    weights: Mutex<HashMap<String, f64>>,
}

impl ConsensusEngine {
    pub fn new() -> Self {
        let mut initial_weights = HashMap::new();
        for (name, w) in WEIGHTS.iter() {
            initial_weights.insert(name.to_string(), *w);
        }
        
        // Coba load dari file RL
        if let Ok(data) = fs::read_to_string("agent_rl_weights.json") {
            if let Ok(parsed) = serde_json::from_str::<HashMap<String, f64>>(&data) {
                log::info!("[Consensus] Loaded self-learning RL weights from file.");
                initial_weights = parsed;
            }
        }
        
        Self {
            active_trade: Mutex::new(None),
            weights: Mutex::new(initial_weights),
        }
    }
    
    fn update_rl_weights(&self, trade: &ActiveTrade, is_win: bool) {
        let mut w_lock = self.weights.lock().unwrap();
        for (agent, vote_dir, conv) in &trade.agent_votes {
            if *vote_dir == Direction::Wait { continue; }
            let is_agent_correct = *vote_dir == trade.direction;
            let current = w_lock.get(agent).copied().unwrap_or(0.1);
            
            // Learning rate = 0.05 * conviction
            let lr = 0.05 * conv;
            let mut new_w = current;
            
            if is_win && is_agent_correct {
                new_w += lr; // Reward
            } else if !is_win && is_agent_correct {
                new_w -= lr * 1.5; // Punish (loss)
            } else if is_win && !is_agent_correct {
                new_w -= lr * 0.5; // Punish slightly for doubting a win
            } else if !is_win && !is_agent_correct {
                new_w += lr * 0.5; // Reward slightly for dodging a loss
            }
            
            w_lock.insert(agent.clone(), new_w.clamp(0.01, 1.0));
        }
        
        // Simpan ke file
        if let Ok(json) = serde_json::to_string_pretty(&*w_lock) {
            let _ = fs::write("agent_rl_weights.json", json);
        }
    }

    pub fn evaluate(&self, votes: &[AgentVote], snap: &MarketSnapshot) -> SignalOutput {
        // Cek trade yang sedang berjalan untuk feedback RL (Self-Learning)
        let price = snap.price;
        let mut trade_finished = false;
        let mut is_win = false;
        
        {
            let mut trade_lock = self.active_trade.lock().unwrap();
            if let Some(trade) = trade_lock.as_mut() {
                if trade.status == "PENDING" {
                    if (trade.direction == Direction::Buy && price <= trade.entry_price) ||
                       (trade.direction == Direction::Sell && price >= trade.entry_price) {
                        trade.status = "OPEN".to_string();
                        log::info!("[RL-Brain] Limit Order Kejemput! Status PENDING -> OPEN @ {}", trade.entry_price);
                    }
                } else if trade.status == "OPEN" {
                    if trade.direction == Direction::Buy {
                        if price >= trade.tp { trade_finished = true; is_win = true; }
                        else if price <= trade.sl { trade_finished = true; is_win = false; }
                    } else if trade.direction == Direction::Sell {
                        if price <= trade.tp { trade_finished = true; is_win = true; }
                        else if price >= trade.sl { trade_finished = true; is_win = false; }
                    }
                }
                
                if trade_finished {
                    log::info!("[RL-Brain] Trade concluded. Win={}, updating agent weights!", is_win);
                    let t = trade.clone();
                    drop(trade_lock); // release lock sebelum update
                    self.update_rl_weights(&t, is_win);
                    let mut lock2 = self.active_trade.lock().unwrap();
                    *lock2 = None;
                }
            }
        }
        
        let ts_ms = Utc::now().timestamp_millis();

        let style_name = read_trading_style();
        let cfg = make_style_config(&style_name);
        log::debug!("[Consensus] style={} min_conf={} noise_veto={} min_rr={}",
            cfg.style_name, cfg.min_confidence, cfg.noise_veto, cfg.min_rr);

        let (ema9, ema21, ema50, ema_bear, ema_bull) = ema_alignment(snap);

        if let Some(reason) = self.check_veto(votes, &cfg) {
            log::warn!("[Otak-AI] BATAL: {reason}");
            return self.make_wait(votes, reason, ts_ms);
        }

        let effective_weights = self.calc_effective_weights(votes, snap, ema_bear, ema_bull);

        let mut score      = 0.0_f64;
        let mut active_w   = 0.0_f64;
        let mut buy_count  = 0_usize;
        let mut sell_count = 0_usize;

        for vote in votes {
            let w = effective_weights.iter()
                .find(|(n, _)| *n == vote.agent)
                .map(|(_, w)| *w)
                .unwrap_or(0.05);

            let sign = match vote.direction {
                Direction::Buy  => { buy_count  += 1;  1.0 },
                Direction::Sell => { sell_count += 1; -1.0 },
                Direction::Wait => 0.0,
            };

            score += w * vote.conviction * sign;
            if vote.direction != Direction::Wait { active_w += w; }
        }

        if active_w > 0.05 {
            score /= active_w;
        } else {
            return self.make_wait(votes, "Tim agen lagi buntu / Pada diem nunggu momen".to_string(), ts_ms);
        }

        let gbm_bias = extract_gbm_bias(votes);
        if gbm_bias > 0.6 && score > 0.0 {
            score *= 1.0 + (gbm_bias - 0.5) * 0.2;
        } else if gbm_bias < 0.4 && score < 0.0 {
            score *= 1.0 + (0.5 - gbm_bias) * 0.2;
        }

        let mut confidence = score.abs().min(1.0);

        let tentative_action = if confidence >= cfg.min_confidence {
            if score > 0.0 && buy_count  >= cfg.min_agree { Direction::Buy  }
            else if score < 0.0 && sell_count >= cfg.min_agree { Direction::Sell }
            else { Direction::Wait }
        } else {
            Direction::Wait
        };

        let strong_consensus = (tentative_action == Direction::Buy  && buy_count  >= 4)
                            || (tentative_action == Direction::Sell && sell_count >= 4);

        let quant_veto = self.check_quant_veto(
            tentative_action, snap,
        );

        let action = match quant_veto {
            QuantVetoResult::Hard(ref reason) => {
                log::warn!("[Consensus] QUANT VETO: {reason}");
                return self.make_wait(votes, reason.clone(), ts_ms);
            }
            QuantVetoResult::Soft(multiplier) => {
                if strong_consensus {
                    log::info!("[Otak-AI] Sinyal kuat dari agen, tembus aja Quant filter!");
                    tentative_action
                } else {
                    confidence *= multiplier;
                    if confidence >= cfg.min_confidence {
                        tentative_action
                    } else {
                        return self.make_wait(
                            votes,
                            format!("Kurang yakin bos, ngeri ngelawan trend EMA (Yakin: {:.3} < Minimal: {:.3})", confidence, cfg.min_confidence),
                            ts_ms,
                        );
                    }
                }
            }
            QuantVetoResult::Clear => tentative_action,
        };

        let raw_atr = snap.atr_14;
        let min_atr = snap.price * 0.002;
        let atr     = raw_atr.max(min_atr);
        let price   = snap.price;

        let (entry, tp, sl) = match action {
            Direction::Buy => {
                let e = price - atr * 0.3; // Nunggu pullback 0.3 ATR (Support)
                let s = e - atr * cfg.sl_atr_mult;
                let t = liq_tp_above(snap, e, atr, cfg.tp_atr_mult * 1.5)
                    .unwrap_or(e + atr * cfg.tp_atr_mult);
                (e, t.max(e + atr * cfg.tp_atr_mult), s)
            }
            Direction::Sell => {
                let e = price + atr * 0.3; // Nunggu pullback 0.3 ATR (Resistance)
                let s = e + atr * cfg.sl_atr_mult;
                let t = liq_tp_below(snap, e, atr, cfg.tp_atr_mult * 1.5)
                    .unwrap_or(e - atr * cfg.tp_atr_mult);
                (e, t.min(e - atr * cfg.tp_atr_mult), s)
            }
            Direction::Wait => (price, price, price),
        };

        let sl_dist = (entry - sl).abs().max(1e-8);
        let tp_dist = (tp - entry).abs();
        let rr      = tp_dist / sl_dist;

        if matches!(action, Direction::Buy | Direction::Sell) && rr < cfg.min_rr {
            let reason = format!("Untungnya kekecilan, mending gausah (RR={:.2} < minimal {:.2})", rr, cfg.min_rr);
            log::warn!("[Otak-AI] {reason}");
            return self.make_wait(votes, reason, ts_ms);
        }

        let mut agent_dirs        = [0u8; AGENT_COUNT];
        let mut agent_convictions = [0.0f64; AGENT_COUNT];
        for (i, vote) in votes.iter().take(AGENT_COUNT).enumerate() {
            agent_dirs[i]        = vote.direction as u8;
            agent_convictions[i] = vote.conviction;
        }

        log::info!(
            "[Otak-AI] Hasil Rapat: {:?} yakin={:.3} BUY={buy_count} SELL={sell_count} score={score:.3} RR={rr:.2} style={} EMA=({:.2},{:.2},{:.2}) bear={ema_bear} bull={ema_bull}",
            action, confidence, cfg.style_name, ema9, ema21, ema50
        );

        let sig = SignalOutput {
            action,
            confidence,
            entry,
            take_profit: tp,
            stop_loss: sl,
            risk_reward: rr,
            veto: false,
            veto_reason: String::new(),
            agent_dirs,
            agent_convictions,
            ts_ms,
        };
        
        // Daftarkan trade baru ke tracker RL jika bukan wait
        if action != Direction::Wait {
            let mut agent_votes = Vec::new();
            for v in votes {
                agent_votes.push((v.agent.to_string(), v.direction, v.conviction));
            }
            let trade = ActiveTrade {
                entry_price: entry, tp, sl, direction: action, agent_votes, status: "PENDING".to_string()
            };
            *self.active_trade.lock().unwrap() = Some(trade);
        }
        
        sig
    }

    fn check_quant_veto(&self, action: Direction, snap: &MarketSnapshot) -> QuantVetoResult {
        match action {
            Direction::Buy => {
                if snap.lsr > 2.5 {
                    QuantVetoResult::Hard(format!("VETO BUY: Market terlalu berat ke Long (LSR={:.2}). Rawan Liquidation Squeeze!", snap.lsr))
                } else if snap.funding_rate > 0.001 {
                    QuantVetoResult::Hard(format!("VETO BUY: Funding Rate terlalu tinggi ({:.4}). Cost of carry mahal!", snap.funding_rate))
                } else { QuantVetoResult::Clear }
            }
            Direction::Sell => {
                if snap.lsr > 0.0 && snap.lsr < 0.5 {
                    QuantVetoResult::Hard(format!("VETO SELL: Market terlalu berat ke Short (LSR={:.2}). Rawan Short Squeeze!", snap.lsr))
                } else if snap.funding_rate < -0.001 {
                    QuantVetoResult::Hard(format!("VETO SELL: Funding Rate negatif ekstrim ({:.4}). Cost of carry mahal!", snap.funding_rate))
                } else { QuantVetoResult::Clear }
            }
            Direction::Wait => QuantVetoResult::Clear,
        }
    }

    fn calc_effective_weights(
        &self, votes: &[AgentVote], snap: &MarketSnapshot, ema_bear: bool, ema_bull: bool,
    ) -> Vec<(&'static str, f64)> {
        let w_lock = self.weights.lock().unwrap();
        // Fallback untuk agen yang belum ada di map
        let mut ew: Vec<(&'static str, f64)> = votes.iter()
            .map(|v| (v.agent, w_lock.get(v.agent).copied().unwrap_or(0.1)))
            .collect();
            
        for (name, weight) in ew.iter_mut() {
            match *name {
                "absurdist" => {
                    if let Some(vote) = votes.iter().find(|v| v.agent == "absurdist") {
                        let conflicts = (ema_bear && vote.direction == Direction::Buy)
                                     || (ema_bull && vote.direction == Direction::Sell);
                        if conflicts { *weight *= ABSURDIST_DAMP; }
                    }
                }
                "linguist" => {
                    if snap.news_count < 3 { *weight *= LINGUIST_DAMP; }
                }
                _ => {}
            }
        }
        ew
    }

    fn check_veto(&self, votes: &[AgentVote], cfg: &StyleConfig) -> Option<String> {
        if let Some(v) = votes.iter().find(|v| v.agent == "data_engineer") {
            if v.reasoning.contains("Blocking execution") {
                return Some(v.reasoning.clone());
            }
        }
        if let Some(v) = votes.iter().find(|v| v.agent == "physicist") {
            if v.reasoning.contains("VOLATILITY CRISIS") {
                return Some(v.reasoning.clone());
            }
        }
        if let Some(v) = votes.iter().find(|v| v.agent == "mathematician") {
            if let Some(noise) = parse_f64_field(&v.reasoning, "noise=") {
                if noise > cfg.noise_veto {
                    return Some(format!("Market lagi choppy/berisik banget nih ({noise:.3} > bates {:.2})", cfg.noise_veto));
                }
            }
            if v.reasoning.contains("anomaly=true") {
                return Some("Ada pergerakan aneh ga ngotak nih (|Z| > 4σ), hold dulu!".into());
            }
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
            action: Direction::Wait,
            confidence: 0.0,
            entry: 0.0, take_profit: 0.0, stop_loss: 0.0, risk_reward: 0.0,
            veto: true,
            veto_reason: reason,
            agent_dirs,
            agent_convictions,
            ts_ms,
        }
    }
}

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

fn liq_tp_above(snap: &MarketSnapshot, price: f64, atr: f64, look_mult: f64) -> Option<f64> {
    let look_range = atr * look_mult;
    let mut candidates: Vec<f64> = Vec::new();
    for candle in &snap.candles {
        let vwap = (candle.high + candle.low + candle.close) / 3.0;
        for &lev in &[10.0_f64, 20.0, 25.0] {
            let short_liq = vwap * (1.0 + 1.0 / lev - 0.004);
            if short_liq > price && (short_liq - price) < look_range {
                candidates.push(short_liq);
            }
        }
    }
    if candidates.is_empty() { return None; }
    candidates.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
    Some(candidates[candidates.len() / 4])
}

fn liq_tp_below(snap: &MarketSnapshot, price: f64, atr: f64, look_mult: f64) -> Option<f64> {
    let look_range = atr * look_mult;
    let mut candidates: Vec<f64> = Vec::new();
    for candle in &snap.candles {
        let vwap = (candle.high + candle.low + candle.close) / 3.0;
        for &lev in &[10.0_f64, 20.0, 25.0] {
            let long_liq = vwap * (1.0 - 1.0 / lev + 0.004);
            if long_liq < price && (price - long_liq) < look_range {
                candidates.push(long_liq);
            }
        }
    }
    if candidates.is_empty() { return None; }
    candidates.sort_unstable_by(|a, b| b.partial_cmp(a).unwrap());
    Some(candidates[candidates.len() / 4])
}
