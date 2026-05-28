// rust-brain/src/consensus/mod.rs
//
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG vs v3.0.3:
//
// [FIX-CONF] READ bot_runtime.conf BUKAN .env
//   ROOT CAUSE: get_style() lama baca dari ".env" via OnceLock.
//   Masalah 1: server.go [FIX-S4] nulis TRADING_STYLE ke "bot_runtime.conf",
//              bukan ".env" — jadi Rust gak pernah dapet nilai dari dashboard.
//   Masalah 2: OnceLock → cuma baca SEKALI saat startup. User ganti style
//              di dashboard → bot_runtime.conf diupdate → Rust gak tau.
//   FIX:
//   - Ganti baca file dari ".env" → "bot_runtime.conf"
//   - Ganti OnceLock → baca file setiap kali evaluate() dipanggil
//     (file read murah, config change jarang — no perf issue)
//   - Tambah fallback: jika bot_runtime.conf tidak ada, coba .env, lalu default
//
// [FIX-C1-v2] EMA TREND HARD/SOFT VETO — dipertahankan
// [FIX-C2]    DYNAMIC WEIGHT DAMPENING — dipertahankan
// [FIX-C3-v2] THRESHOLD SCALPING FIX — dipertahankan
// [FIX-C4]    TP/SL SANITY ATR FLOOR — dipertahankan
// [FIX-C6-NEW] CONSENSUS OVERRIDE 4+ AGENTS — dipertahankan
// ═══════════════════════════════════════════════════════════════════════════

use crate::agents::{AgentVote, Direction};
use crate::shm::{MarketSnapshot, SignalOutput, AGENT_COUNT};
use chrono::Utc;

const WEIGHTS: [(&str, f64); AGENT_COUNT] = [
    ("mathematician", 0.28),
    ("physicist",     0.22),
    ("cryptographer", 0.20),
    ("linguist",      0.12),
    ("liquidator",    0.08),
    ("absurdist",     0.10),
];

const ABSURDIST_DAMP: f64 = 0.30;
const LINGUIST_DAMP:  f64 = 0.50;

// [FIX-CONF] StyleConfig tidak lagi di-cache via OnceLock.
// Di-construct fresh setiap evaluate() call dari bot_runtime.conf.
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

// [FIX-CONF] Baca TRADING_STYLE dari bot_runtime.conf (diwrite server.go tiap
// user save config di dashboard). Fallback ke .env, lalu ke "scalping".
fn read_trading_style() -> String {
    // Priority 1: bot_runtime.conf (diupdate server.go tanpa restart)
    // Priority 2: .env (backward compat)
    // Priority 3: default "scalping"
    for filename in &["bot_runtime.conf", ".env"] {
        if let Ok(content) = std::fs::read_to_string(filename) {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    continue;
                }
                if line.starts_with("TRADING_STYLE=") {
                    let val = line["TRADING_STYLE=".len()..]
                        .trim()
                        .trim_matches('"')
                        .trim_matches('\'')
                        .to_lowercase();
                    if !val.is_empty() {
                        return val;
                    }
                }
            }
        }
    }
    "scalping".to_string()
}

// [FIX-CONF] Build StyleConfig dari style name string.
fn make_style_config(style_name: &str) -> StyleConfig {
    match style_name {
        "scalping" => StyleConfig {
            style_name:     style_name.to_string(),
            // [FIX-C3-v2] min_confidence: 0.18 (realistis setelah active_w normalisasi)
            min_confidence: 0.18,
            min_agree:      2,
            tp_atr_mult:    1.2,
            sl_atr_mult:    0.7,
            noise_veto:     0.82,
            min_rr:         1.2,
        },
        "daytrading" | "daytrade" | "day" => StyleConfig {
            style_name:     style_name.to_string(),
            // [FIX-C3-v2] min_confidence: 0.38
            min_confidence: 0.38,
            min_agree:      3,
            tp_atr_mult:    2.2,
            sl_atr_mult:    1.2,
            noise_veto:     0.68,
            min_rr:         1.5,
        },
        "swing" | "sniper" | "sniper_swing" => StyleConfig {
            style_name:     style_name.to_string(),
            // [FIX-C3-v2] min_confidence: 0.50
            min_confidence: 0.50,
            min_agree:      3,
            tp_atr_mult:    3.5,
            sl_atr_mult:    1.5,
            noise_veto:     0.55,
            min_rr:         2.0,
        },
        _ => {
            log::warn!("[Consensus] [FIX-CONF] Unknown TRADING_STYLE='{style_name}', using scalping defaults");
            StyleConfig {
                style_name:     style_name.to_string(),
                min_confidence: 0.18,
                min_agree:      2,
                tp_atr_mult:    1.5,
                sl_atr_mult:    1.0,
                noise_veto:     0.78,
                min_rr:         1.2,
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// EMA helpers
// ═══════════════════════════════════════════════════════════════════════════

fn calc_ema(closes: &[f64], period: usize) -> f64 {
    if closes.is_empty() {
        return 0.0;
    }
    if closes.len() < period {
        return closes.iter().sum::<f64>() / closes.len() as f64;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = closes[..period].iter().sum::<f64>() / period as f64;
    for &c in &closes[period..] {
        ema = c * k + ema * (1.0 - k);
    }
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

// ═══════════════════════════════════════════════════════════════════════════
// [FIX-C1-v2] EmaVetoResult
// ═══════════════════════════════════════════════════════════════════════════
#[derive(Debug)]
enum EmaVetoResult {
    Hard(String),
    Soft(f64),
    Clear,
}

pub struct ConsensusEngine;

impl ConsensusEngine {
    pub fn evaluate(&self, votes: &[AgentVote], snap: &MarketSnapshot) -> SignalOutput {
        let ts_ms = Utc::now().timestamp_millis();

        // [FIX-CONF] Baca style dari file setiap evaluate() — tidak ada OnceLock.
        // Ini memungkinkan user ganti TRADING_STYLE di dashboard langsung efektif
        // tanpa restart binary. File read cost ~microseconds, tradeoff OK.
        let style_name = read_trading_style();
        let cfg = make_style_config(&style_name);
        log::debug!("[Consensus] [FIX-CONF] style={} min_conf={} min_agree={} tp_mult={} sl_mult={}",
            cfg.style_name, cfg.min_confidence, cfg.min_agree, cfg.tp_atr_mult, cfg.sl_atr_mult);

        // Pre-compute EMA alignment sekali untuk semua checks
        let (ema9, ema21, ema50, ema_bear, ema_bull) = ema_alignment(snap);

        // ── VETO CHAIN (volatility crisis + noise) ───────────────────────────
        if let Some(reason) = self.check_veto(votes, &cfg) {
            log::warn!("[Consensus] VETO: {reason}");
            return self.make_wait(votes, reason, ts_ms);
        }

        // ── [FIX-C2] Dynamic weight berdasarkan EMA alignment ────────────────
        let effective_weights = self.calc_effective_weights(votes, snap, ema_bear, ema_bull);

        // ── Weighted Scoring dengan active_w normalisasi [FIX-C3-v2] ─────────
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

            if vote.direction != Direction::Wait {
                active_w += w;
            }
        }

        // [FIX-C3-v2] Normalisasi dengan active_weight saja
        if active_w > 0.05 {
            score /= active_w;
        } else {
            return self.make_wait(votes, "No active agent opinions".to_string(), ts_ms);
        }

        // GBM bias boost
        let gbm_bias = extract_gbm_bias(votes);
        if gbm_bias > 0.6 && score > 0.0 {
            score *= 1.0 + (gbm_bias - 0.5) * 0.2;
        } else if gbm_bias < 0.4 && score < 0.0 {
            score *= 1.0 + (0.5 - gbm_bias) * 0.2;
        }

        let mut confidence = score.abs().min(1.0);

        // ── Decision Tree ────────────────────────────────────────────────────
        let tentative_action = if confidence >= cfg.min_confidence {
            if score > 0.0 && buy_count  >= cfg.min_agree { Direction::Buy  }
            else if score < 0.0 && sell_count >= cfg.min_agree { Direction::Sell }
            else { Direction::Wait }
        } else {
            Direction::Wait
        };

        // ── [FIX-C1-v2] EMA TREND VETO (SOFT+HARD) ───────────────────────────
        // [FIX-C6-NEW] Override: jika strong consensus (4+ agents), skip soft veto
        let strong_consensus = (tentative_action == Direction::Buy && buy_count >= 4)
            || (tentative_action == Direction::Sell && sell_count >= 4);

        let ema_veto = self.check_ema_trend_veto_v2(
            tentative_action, snap.price, ema9, ema21, ema50, ema_bear, ema_bull,
        );

        let action = match ema_veto {
            EmaVetoResult::Hard(ref reason) => {
                log::warn!("[Consensus] [FIX-C1-v2] HARD EMA VETO: {reason}");
                return self.make_wait(votes, reason.clone(), ts_ms);
            }
            EmaVetoResult::Soft(multiplier) => {
                if strong_consensus {
                    log::info!(
                        "[Consensus] [FIX-C6] Strong consensus ({} agents) override EMA soft veto",
                        if tentative_action == Direction::Buy { buy_count } else { sell_count }
                    );
                    tentative_action
                } else {
                    confidence *= multiplier;
                    log::info!(
                        "[Consensus] [FIX-C1-v2] EMA soft conflict — confidence penalized to {:.3} (×{:.2})",
                        confidence, multiplier
                    );
                    if confidence >= cfg.min_confidence {
                        tentative_action
                    } else {
                        log::info!(
                            "[Consensus] [FIX-C1-v2] Post-penalty confidence {:.3} < threshold {:.3} — WAIT",
                            confidence, cfg.min_confidence
                        );
                        return self.make_wait(
                            votes,
                            format!(
                                "[FIX-C1-v2] EMA soft conflict: post-penalty conf={:.3} < min={:.3}",
                                confidence, cfg.min_confidence
                            ),
                            ts_ms,
                        );
                    }
                }
            }
            EmaVetoResult::Clear => tentative_action,
        };

        // ── [FIX-C4] TP/SL dengan minimum ATR floor ──────────────────────────
        let raw_atr = snap.atr_14;
        let min_atr = snap.price * 0.002; // 0.2% floor
        let atr     = raw_atr.max(min_atr);
        let price   = snap.price;

        let (entry, tp, sl) = match action {
            Direction::Buy => {
                let e = price;
                let s = price - atr * cfg.sl_atr_mult;
                let t = liq_tp_above(snap, price, atr, cfg.tp_atr_mult * 1.5)
                    .unwrap_or(price + atr * cfg.tp_atr_mult);
                (e, t.max(e + atr * cfg.tp_atr_mult), s)
            }
            Direction::Sell => {
                let e = price;
                let s = price + atr * cfg.sl_atr_mult;
                let t = liq_tp_below(snap, price, atr, cfg.tp_atr_mult * 1.5)
                    .unwrap_or(price - atr * cfg.tp_atr_mult);
                (e, t.min(e - atr * cfg.tp_atr_mult), s)
            }
            Direction::Wait => (price, price, price),
        };

        let sl_dist = (entry - sl).abs().max(1e-8);
        let tp_dist = (tp - entry).abs();
        let rr      = tp_dist / sl_dist;

        // [FIX-C4] RR minimum check
        if matches!(action, Direction::Buy | Direction::Sell) && rr < cfg.min_rr {
            let reason = format!(
                "RR={:.2} < min_rr={:.2} (ATR={:.4} floor={:.4}) — signal rejected",
                rr, cfg.min_rr, raw_atr, min_atr
            );
            log::warn!("[Consensus] [FIX-C4] {reason}");
            return self.make_wait(votes, reason, ts_ms);
        }

        let mut agent_dirs        = [0u8; AGENT_COUNT];
        let mut agent_convictions = [0.0f64; AGENT_COUNT];
        for (i, vote) in votes.iter().take(AGENT_COUNT).enumerate() {
            agent_dirs[i]        = vote.direction as u8;
            agent_convictions[i] = vote.conviction;
        }

        log::info!(
            "[Consensus] {:?} conf={:.3} BUY={buy_count} SELL={sell_count} score={score:.3} RR={rr:.2} style={} EMA=({:.2},{:.2},{:.2}) bear={ema_bear} bull={ema_bull} strong={strong_consensus}",
            action, confidence, cfg.style_name, ema9, ema21, ema50
        );

        SignalOutput {
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
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [FIX-C1-v2] EMA trend veto — SOFT + HARD
    // HARD  : price > 2.5% melawan EMA50 saat bear/bull align
    // SOFT  : price sedikit melawan — confidence *= 0.60
    // CLEAR : tidak ada conflict
    // ═══════════════════════════════════════════════════════════════════════
    fn check_ema_trend_veto_v2(
        &self,
        action: Direction,
        price: f64,
        ema9: f64, ema21: f64, ema50: f64,
        ema_bear: bool, ema_bull: bool,
    ) -> EmaVetoResult {
        match action {
            Direction::Buy => {
                if ema_bear {
                    if price < ema50 * 0.975 {
                        EmaVetoResult::Hard(format!(
                            "[FIX-C1-v2] BUY HARD blocked: EMA bear-align (9={:.2}<21={:.2}<50={:.2}) \
                             + price={:.4} far below EMA50*0.975={:.4} ({:.2}% gap)",
                            ema9, ema21, ema50, price, ema50 * 0.975,
                            (ema50 - price) / ema50 * 100.0
                        ))
                    } else if price < ema50 {
                        EmaVetoResult::Soft(0.60)
                    } else {
                        EmaVetoResult::Clear
                    }
                } else {
                    EmaVetoResult::Clear
                }
            }
            Direction::Sell => {
                if ema_bull {
                    if price > ema50 * 1.025 {
                        EmaVetoResult::Hard(format!(
                            "[FIX-C1-v2] SELL HARD blocked: EMA bull-align (9={:.2}>21={:.2}>50={:.2}) \
                             + price={:.4} far above EMA50*1.025={:.4} ({:.2}% gap)",
                            ema9, ema21, ema50, price, ema50 * 1.025,
                            (price - ema50) / ema50 * 100.0
                        ))
                    } else if price > ema50 {
                        EmaVetoResult::Soft(0.60)
                    } else {
                        EmaVetoResult::Clear
                    }
                } else {
                    EmaVetoResult::Clear
                }
            }
            Direction::Wait => EmaVetoResult::Clear,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [FIX-C2] Dynamic weight dampening
    // ═══════════════════════════════════════════════════════════════════════
    fn calc_effective_weights(
        &self,
        votes: &[AgentVote],
        snap: &MarketSnapshot,
        ema_bear: bool,
        ema_bull: bool,
    ) -> Vec<(&'static str, f64)> {
        let mut ew: Vec<(&'static str, f64)> = WEIGHTS.iter().map(|&(n, w)| (n, w)).collect();

        for (name, weight) in ew.iter_mut() {
            match *name {
                "absurdist" => {
                    let abs_vote = votes.iter().find(|v| v.agent == "absurdist");
                    if let Some(vote) = abs_vote {
                        let conflicts = (ema_bear && vote.direction == Direction::Buy)
                            || (ema_bull && vote.direction == Direction::Sell);
                        if conflicts {
                            let old_w = *weight;
                            *weight *= ABSURDIST_DAMP;
                            log::debug!(
                                "[FIX-C2] Absurdist weight dampened {:.3}→{:.3} (EMA conflict: bear={ema_bear} bull={ema_bull})",
                                old_w, *weight
                            );
                        }
                    }
                }
                "linguist" => {
                    if snap.news_count < 3 {
                        *weight *= LINGUIST_DAMP;
                    }
                }
                _ => {}
            }
        }
        ew
    }

    fn check_veto(&self, votes: &[AgentVote], cfg: &StyleConfig) -> Option<String> {
        if let Some(v) = votes.iter().find(|v| v.agent == "physicist") {
            if v.reasoning.contains("VOLATILITY CRISIS") {
                return Some(v.reasoning.clone());
            }
        }
        if let Some(v) = votes.iter().find(|v| v.agent == "mathematician") {
            if let Some(noise) = parse_f64_field(&v.reasoning, "noise=") {
                if noise > cfg.noise_veto {
                    return Some(format!(
                        "Market noise {noise:.3} > threshold {:.2}",
                        cfg.noise_veto
                    ));
                }
            }
            if v.reasoning.contains("anomaly=true") {
                return Some("Mathematical anomaly detected (|Z| > 4σ)".into());
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
            entry: 0.0,
            take_profit: 0.0,
            stop_loss: 0.0,
            risk_reward: 0.0,
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
    let end = rest.find(|c: char| c == ' ' || c == ',' || c == ']')
        .unwrap_or(rest.len());
    rest[..end].parse::<f64>().ok()
}

fn liq_tp_above(snap: &MarketSnapshot, price: f64, atr: f64, look_mult: f64) -> Option<f64> {
    let look_range = atr * look_mult;
    let total_vol: f64 = snap.candles.iter().map(|c| c.vol).sum();
    if total_vol < 1.0 {
        return None;
    }
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
    if candidates.is_empty() {
        None
    } else {
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
            let long_liq = vwap * (1.0 - 1.0 / lev + 0.004);
            if long_liq < price && (price - long_liq) < look_range {
                candidates.push(long_liq);
            }
        }
    }
    if candidates.is_empty() {
        None
    } else {
        candidates.sort_unstable_by(|a, b| b.partial_cmp(a).unwrap());
        Some(candidates[candidates.len() / 4])
    }
}
