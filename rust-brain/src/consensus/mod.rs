// rust-brain/src/consensus/mod.rs
//
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG vs v3.0.2:
//
// [FIX-C1] EMA TREND HARD VETO — Problem 5
//   (dari sesi sebelumnya — dipertahankan, diperbaiki di v2)
//
// [FIX-C1-v2] ← FIX UTAMA PROBLEM 2 + 5 INI
//   ROOT CAUSE FIX-C1-v1 TERLALU AGRESIF:
//   Threshold lama: price < ema50 * 0.995 (hanya 0.5% di bawah EMA50)
//   Akibat: di SETIAP downtrend, SEMUA sinyal BUY di-hard-veto karena
//   harga selalu sedikit di bawah EMA50 saat bear alignment.
//   Ini menyebabkan "gada entry sama sekali" di demo backtest.
//
//   FIX:
//   - HARD VETO hanya saat price < ema50 * 0.975 (2.5% di bawah = downtrend serius)
//   - SOFT VETO (confidence penalty) saat price antara ema50*0.975 dan ema50*1.0
//     → confidence dikali 0.60 (dikurangi 40%) + require 1 extra agreement
//   - Efek: bot masih bisa masuk di downtrend ringan, tapi dengan conviction lebih tinggi
//   - LSR whale fake tetap dibatasi oleh [FIX-C2] weight dampening
//
// [FIX-C2] DYNAMIC WEIGHT DAMPENING — LSR anti-manipulation
//   (dari sesi sebelumnya — dipertahankan)
//   Absurdist weight direduksi ke 30% saat EMA conflict terdeteksi.
//   Linguist direduksi ke 50% saat news_count < 3.
//
// [FIX-C3-v2] ← FIX THRESHOLD SCALPING
//   min_confidence scalping: 0.25 → 0.18
//   ROOT CAUSE: active_w normalization membuat skor aktual lebih rendah dari
//   ekspektasi. Dengan 3-4 agent vote WAIT, active_w bisa ~0.5, sehingga
//   confidence efektif = raw_score/0.5. Threshold 0.25 terlalu ketat.
//   FIX: 0.18 untuk scalping (cukup ketat tapi reachable)
//       0.38 untuk daytrade (turun dari 0.42)
//       0.50 untuk swing/sniper (turun dari 0.55)
//
// [FIX-C4] TP/SL SANITY — ATR floor 0.2%
//   (dari sesi sebelumnya — dipertahankan)
//
// [FIX-C6-NEW] ← CONSENSUS OVERRIDE UNTUK STRONG SIGNAL
//   Jika buy_count >= 4 (dari 6 agents) DAN confidence >= 0.40, skip EMA
//   soft veto. Strong consensus = 4+ agents setuju = signal valid meski
//   EMA tidak ideal. Ini mencegah over-filtering saat whale genuinely BUY.
//
// MARKING: FIX-C1-v2, FIX-C3-v2, FIX-C6-NEW
// ═══════════════════════════════════════════════════════════════════════════

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

const ABSURDIST_DAMP:  f64 = 0.30;
const LINGUIST_DAMP:   f64 = 0.50;

struct StyleConfig {
    min_confidence: f64,
    min_agree:      usize,
    tp_atr_mult:    f64,
    sl_atr_mult:    f64,
    noise_veto:     f64,
    min_rr:         f64,
}

fn get_style() -> &'static StyleConfig {
    static STYLE: OnceLock<StyleConfig> = OnceLock::new();
    STYLE.get_or_init(|| {
        let mut style_name = String::from("scalping");
        if let Ok(content) = std::fs::read_to_string(".env") {
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue; }
                if line.starts_with("TRADING_STYLE=") {
                    style_name = line["TRADING_STYLE=".len()..]
                        .trim()
                        .trim_matches('"')
                        .trim_matches('\'')
                        .to_lowercase();
                    break;
                }
            }
        }
        log::info!("[Consensus] Trading style loaded: '{style_name}'");

        match style_name.as_str() {
            "scalping" => StyleConfig {
                // [FIX-C3-v2] min_confidence: 0.25 → 0.18 (threshold realistis setelah active_w normalisasi)
                min_confidence: 0.18,
                min_agree:      2,
                tp_atr_mult:    1.2,
                sl_atr_mult:    0.7,
                noise_veto:     0.82,
                min_rr:         1.2,
            },
            "daytrading" | "daytrade" | "day" => StyleConfig {
                // [FIX-C3-v2] min_confidence: 0.42 → 0.38
                min_confidence: 0.38,
                min_agree:      3,
                tp_atr_mult:    2.2,
                sl_atr_mult:    1.2,
                noise_veto:     0.68,
                min_rr:         1.5,
            },
            "swing" | "sniper" | "sniper_swing" => StyleConfig {
                // [FIX-C3-v2] min_confidence: 0.55 → 0.50
                min_confidence: 0.50,
                min_agree:      3,
                tp_atr_mult:    3.5,
                sl_atr_mult:    1.5,
                noise_veto:     0.55,
                min_rr:         2.0,
            },
            _ => {
                log::warn!("[Consensus] Unknown TRADING_STYLE='{style_name}', using scalping defaults");
                StyleConfig {
                    min_confidence: 0.18, // [FIX-C3-v2] default juga diperbaiki
                    min_agree:      2,
                    tp_atr_mult:    1.5,
                    sl_atr_mult:    1.0,
                    noise_veto:     0.78,
                    min_rr:         1.2,
                }
            }
        }
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// EMA helpers
// ═══════════════════════════════════════════════════════════════════════════

fn calc_ema(closes: &[f64], period: usize) -> f64 {
    if closes.is_empty() { return 0.0; }
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
// [FIX-C1-v2] EmaVetoResult — hasil dari EMA trend check
//   Hard  = block total (hanya saat price sangat jauh dari trend)
//   Soft  = confidence penalty (masih bisa masuk tapi butuh lebih yakin)
//   Clear = tidak ada conflict
// ═══════════════════════════════════════════════════════════════════════════
#[derive(Debug)]
enum EmaVetoResult {
    /// Hard block — price sangat melawan trend (>2.5% dari EMA50)
    Hard(String),
    /// Soft penalty — EMA alignment melawan tapi tidak ekstrem
    /// Parameter: confidence_multiplier (misal 0.60 = potong 40%)
    Soft(f64),
    /// Tidak ada conflict
    Clear,
}

pub struct ConsensusEngine;

impl ConsensusEngine {
    pub fn evaluate(&self, votes: &[AgentVote], snap: &MarketSnapshot) -> SignalOutput {
        let ts_ms = Utc::now().timestamp_millis();
        let cfg   = get_style();

        // Pre-compute EMA alignment sekali untuk semua checks
        let (ema9, ema21, ema50, ema_bear, ema_bull) = ema_alignment(snap);

        // ── VETO CHAIN (volatility crisis + noise) ───────────────────────────
        if let Some(reason) = self.check_veto(votes, cfg) {
            log::warn!("[Consensus] VETO: {reason}");
            return self.make_wait(votes, reason, ts_ms);
        }

        // ── [FIX-C2] Dynamic weight berdasarkan EMA alignment ────────────────
        let effective_weights = self.calc_effective_weights(votes, snap, ema_bear, ema_bull);

        // ── Weighted Scoring dengan active_w normalisasi [FIX-C3-v2] ─────────
        let mut score       = 0.0_f64;
        let mut active_w    = 0.0_f64;
        let mut buy_count   = 0_usize;
        let mut sell_count  = 0_usize;

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

        // [FIX-C3-v2] Normalisasi dengan active_weight saja (bukan total_weight)
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
            tentative_action, snap.price, ema9, ema21, ema50, ema_bear, ema_bull
        );

        let action = match ema_veto {
            EmaVetoResult::Hard(ref reason) => {
                // [FIX-C1-v2] Hard veto: price sangat melawan trend (>2.5%)
                // [FIX-C6-NEW] Strong consensus TIDAK override hard veto
                log::warn!("[Consensus] [FIX-C1-v2] HARD EMA VETO: {reason}");
                return self.make_wait(votes, reason.clone(), ts_ms);
            }
            EmaVetoResult::Soft(multiplier) => {
                if strong_consensus {
                    // [FIX-C6-NEW] Strong consensus override soft veto
                    log::info!(
                        "[Consensus] [FIX-C6] Strong consensus ({} agents) override EMA soft veto",
                        if tentative_action == Direction::Buy { buy_count } else { sell_count }
                    );
                    tentative_action
                } else {
                    // [FIX-C1-v2] Apply confidence penalty
                    confidence *= multiplier;
                    log::info!(
                        "[Consensus] [FIX-C1-v2] EMA soft conflict — confidence penalized to {:.3} (×{:.2})",
                        confidence, multiplier
                    );
                    // Re-check threshold setelah penalty
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
            "[Consensus] {:?} conf={:.3} BUY={buy_count} SELL={sell_count} score={score:.3} RR={rr:.2} EMA=({:.2},{:.2},{:.2}) bear={ema_bear} bull={ema_bull} strong={strong_consensus}",
            action, confidence, ema9, ema21, ema50
        );

        SignalOutput {
            action, confidence, entry, take_profit: tp, stop_loss: sl,
            risk_reward: rr, veto: false, veto_reason: String::new(),
            agent_dirs, agent_convictions, ts_ms,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [FIX-C1-v2] check_ema_trend_veto_v2 — SOFT + HARD veto
    //
    // SEBELUMNYA (v1):
    //   Hard veto saat price < ema50 * 0.995 (0.5% di bawah) → TERLALU AGRESIF
    //   Semua buy di downtrend ringan langsung diblok → "gada entry sama sekali"
    //
    // SESUDAH (v2):
    //   HARD veto  : price < ema50 * 0.975 (2.5% di bawah = downtrend serius)
    //   SOFT veto  : price antara ema50*0.975 dan ema50*1.0 (ema bear + sedikit di bawah)
    //                → confidence *= 0.60 (potong 40%), tidak langsung diblok
    //   CLEAR      : price di atas ema50 atau tidak ada EMA conflict
    //
    // Untuk SELL di uptrend:
    //   HARD veto  : price > ema50 * 1.025 (2.5% di atas)
    //   SOFT veto  : price antara ema50*1.0 dan ema50*1.025
    // ═══════════════════════════════════════════════════════════════════════
    fn check_ema_trend_veto_v2(
        &self,
        action: Direction,
        price: f64,
        ema9: f64, ema21: f64, ema50: f64,
        ema_bear: bool, ema_bull: bool
    ) -> EmaVetoResult {
        match action {
            Direction::Buy => {
                if ema_bear {
                    if price < ema50 * 0.975 {
                        // [FIX-C1-v2] HARD VETO: harga 2.5%+ di bawah EMA50 + bear align
                        // Ini beneran downtrend serius, LSR whale tidak bisa justify entry
                        EmaVetoResult::Hard(format!(
                            "[FIX-C1-v2] BUY HARD blocked: EMA bear-align (9={:.2}<21={:.2}<50={:.2}) \
                             + price={:.4} far below EMA50*0.975={:.4} ({:.2}% gap) — trend too strong",
                            ema9, ema21, ema50, price, ema50 * 0.975,
                            (ema50 - price) / ema50 * 100.0
                        ))
                    } else if price < ema50 {
                        // [FIX-C1-v2] SOFT VETO: harga sedikit di bawah EMA50 + bear align
                        // Masih bisa entry tapi butuh lebih yakin (confidence dipotong 40%)
                        EmaVetoResult::Soft(0.60)
                    } else {
                        // Harga di atas EMA50 meski EMA alignment bearish — valid untuk kontratrend
                        EmaVetoResult::Clear
                    }
                } else {
                    EmaVetoResult::Clear
                }
            }
            Direction::Sell => {
                if ema_bull {
                    if price > ema50 * 1.025 {
                        // [FIX-C1-v2] HARD VETO: harga 2.5%+ di atas EMA50 + bull align
                        EmaVetoResult::Hard(format!(
                            "[FIX-C1-v2] SELL HARD blocked: EMA bull-align (9={:.2}>21={:.2}>50={:.2}) \
                             + price={:.4} far above EMA50*1.025={:.4} ({:.2}% gap) — uptrend too strong",
                            ema9, ema21, ema50, price, ema50 * 1.025,
                            (price - ema50) / ema50 * 100.0
                        ))
                    } else if price > ema50 {
                        // [FIX-C1-v2] SOFT VETO: harga sedikit di atas EMA50 + bull align
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
    // [FIX-C2] DYNAMIC WEIGHT DAMPENING — dipertahankan dari v1
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
                            // [FIX-C2] LSR fake signal: absurdist weight dikurangi 70%
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
                    // [FIX-C2] Berita sedikit = noise tinggi, kurangi pengaruh
                    if snap.news_count < 3 {
                        *weight *= LINGUIST_DAMP;
                    }
                }
                _ => {}
            }
        }
        ew
    }

    // VETO CHAIN lama: noise + volatility crisis — dipertahankan
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
            action: Direction::Wait, confidence: 0.0,
            entry: 0.0, take_profit: 0.0, stop_loss: 0.0, risk_reward: 0.0,
            veto: true, veto_reason: reason, agent_dirs, agent_convictions, ts_ms,
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
