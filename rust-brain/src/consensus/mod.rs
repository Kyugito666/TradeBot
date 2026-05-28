// rust-brain/src/consensus/mod.rs
//
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG vs v3.0.2:
//
// [FIX-C1] EMA TREND HARD VETO — Problem 5
//   ROOT CAUSE: Absurdist (LSR-based) + Linguist bisa vote BUY dengan
//   conviction tinggi meski trend teknikal clear downtrend. Score gabungan
//   melewati min_confidence lalu bot LONG padahal EMA9<EMA21<EMA50.
//   FIX: Tambah check_ema_trend_veto() sebelum final decision.
//   - EMA9<EMA21<EMA50 + price<EMA50*0.99 + signal BUY → HARD VETO
//   - EMA9>EMA21>EMA50 + price>EMA50*1.01 + signal SELL → HARD VETO
//   - Soft penalty: EMA bear-align tapi signal BUY → bullScore *= 0.4
//
// [FIX-C2] DYNAMIC WEIGHT DAMPENING — LSR anti-manipulation
//   ROOT CAUSE: Absurdist weight=0.10 bisa terlalu dominan ketika agents
//   lain tie (3 BUY vs 3 SELL). LSR fake dari whale hedging.
//   FIX: Jika EMA alignment bertentangan dengan absurdist vote →
//   absurdist effective weight dikurangi 70% secara dinamis.
//   Linguist juga dikurangi 50% jika news_count < 3 (data tipis).
//
// [FIX-C3] DEMO ENTRY FIX — thresholds lebih realistis
//   ROOT CAUSE: scalping min_confidence=0.35 tapi score dinormalisasi
//   dengan total_weight=1.0. Nilai aktual score sering 0.15-0.30 karena
//   banyak agents vote WAIT (conviction=0). Akibatnya bot tidak pernah entry.
//   FIX:
//   - min_confidence scalping: 0.35 → 0.25 (lebih sensitif)
//   - min_agree: 2 → 2 (tetap, tapi hitung EXCLUDING wait votes)
//   - Ganti normalisasi: tidak dibagi total_weight, dibagi active_weight
//     (weight agents yang tidak WAIT). Ini mencerminkan conviction nyata.
//
// [FIX-C4] TP/SL SANITY — demo paper trade TP/SL valid
//   ROOT CAUSE: liq_tp_above() bisa return None lalu fallback ke ATR mult.
//   Jika ATR sangat kecil (< price*0.001), TP terlalu dekat ke entry →
//   RR < 1.5 → Go side skip order. Akibat: zero entries di demo.
//   FIX: minimum ATR floor = price * 0.002 (0.2%) sebelum kalkulasi TP/SL.
//   RR minimum di sini: 1.5× (agar tidak terlalu mudah tapi reachable).
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

// [FIX-C2] Faktor reduksi weight ketika EMA conflict terdeteksi
const ABSURDIST_DAMP:  f64 = 0.30; // hanya 30% dari weight asli saat conflict
const LINGUIST_DAMP:   f64 = 0.50; // hanya 50% saat news_count < 3

struct StyleConfig {
    min_confidence: f64,
    min_agree:      usize,
    tp_atr_mult:    f64,
    sl_atr_mult:    f64,
    noise_veto:     f64,
    min_rr:         f64, // [FIX-C4] minimum RR agar order tidak di-skip Go
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
                min_confidence: 0.25, // [FIX-C3] turun dari 0.35
                min_agree:      2,
                tp_atr_mult:    1.2,  // [FIX-C4] naik sedikit agar RR > 1.5
                sl_atr_mult:    0.7,
                noise_veto:     0.82,
                min_rr:         1.2,
            },
            "daytrading" | "daytrade" | "day" => StyleConfig {
                min_confidence: 0.42, // [FIX-C3] turun dari 0.50
                min_agree:      3,
                tp_atr_mult:    2.2,
                sl_atr_mult:    1.2,
                noise_veto:     0.68,
                min_rr:         1.5,
            },
            "swing" | "sniper" | "sniper_swing" => StyleConfig {
                min_confidence: 0.55, // [FIX-C3] turun dari 0.62
                min_agree:      3,    // turun dari 4 — 4 terlalu ketat
                tp_atr_mult:    3.5,
                sl_atr_mult:    1.5,
                noise_veto:     0.55,
                min_rr:         2.0,
            },
            _ => {
                log::warn!("[Consensus] Unknown TRADING_STYLE='{style_name}', using scalping defaults");
                StyleConfig {
                    min_confidence: 0.25,
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
// [FIX-C1] EMA helpers
// ═══════════════════════════════════════════════════════════════════════════

/// Hitung Exponential Moving Average dari slice harga (oldest-first)
fn calc_ema(closes: &[f64], period: usize) -> f64 {
    if closes.is_empty() { return 0.0; }
    if closes.len() < period {
        // tidak cukup data — pakai SMA
        return closes.iter().sum::<f64>() / closes.len() as f64;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = closes[..period].iter().sum::<f64>() / period as f64;
    for &c in &closes[period..] {
        ema = c * k + ema * (1.0 - k);
    }
    ema
}

/// Detect EMA alignment dari candle data.
/// Returns (ema9, ema21, ema50, bear_align, bull_align)
fn ema_alignment(snap: &MarketSnapshot) -> (f64, f64, f64, bool, bool) {
    let closes: Vec<f64> = snap.candles.iter().map(|c| c.close).collect();
    if closes.len() < 50 {
        return (snap.price, snap.price, snap.price, false, false);
    }
    let ema9  = calc_ema(&closes, 9);
    let ema21 = calc_ema(&closes, 21);
    let ema50 = calc_ema(&closes, 50);
    let bear  = ema9 < ema21 && ema21 < ema50; // EMA9 < EMA21 < EMA50
    let bull  = ema9 > ema21 && ema21 > ema50; // EMA9 > EMA21 > EMA50
    (ema9, ema21, ema50, bear, bull)
}

pub struct ConsensusEngine;

impl ConsensusEngine {
    pub fn evaluate(&self, votes: &[AgentVote], snap: &MarketSnapshot) -> SignalOutput {
        let ts_ms = Utc::now().timestamp_millis();
        let cfg   = get_style();

        // ── Pre-compute EMA alignment once ─────────────────────────────────
        // [FIX-C1] dipakai untuk veto chain DAN dynamic weight adjustment
        let (ema9, ema21, ema50, ema_bear, ema_bull) = ema_alignment(snap);

        // ── VETO CHAIN ───────────────────────────────────────────────────────
        if let Some(reason) = self.check_veto(votes, cfg) {
            log::warn!("[Consensus] VETO: {reason}");
            return self.make_wait(votes, reason, ts_ms);
        }

        // ── [FIX-C2] Dynamic weight adjustment berdasarkan EMA alignment ────
        // Jika EMA alignment clear, kurangi weight agent yang "berbahaya" (LSR-based)
        let effective_weights = self.calc_effective_weights(votes, snap, ema_bear, ema_bull);

        // ── Weighted Scoring dengan effective_weights ────────────────────────
        let mut score       = 0.0_f64;
        let mut active_w    = 0.0_f64; // [FIX-C3] hanya sum weight agent NON-WAIT
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

            score   += w * vote.conviction * sign;

            // [FIX-C3] hanya akumulasi weight agent yang punya opini
            if vote.direction != Direction::Wait {
                active_w += w;
            }
        }

        // [FIX-C3] Normalisasi dengan active_weight, bukan total_weight
        // Ini mencerminkan confidence nyata dari agents yang PUNYA OPINI
        // Jika semua agents vote WAIT → active_w = 0 → score = 0 (aman)
        if active_w > 0.1 {
            score /= active_w;
        } else {
            // Tidak ada agent yang punya opini kuat → WAIT
            return self.make_wait(votes, "No active agent opinions".to_string(), ts_ms);
        }

        // ── GBM Bias Adjustment ──────────────────────────────────────────────
        let gbm_bias = extract_gbm_bias(votes);
        if gbm_bias > 0.6 && score > 0.0 {
            score *= 1.0 + (gbm_bias - 0.5) * 0.2;
        } else if gbm_bias < 0.4 && score < 0.0 {
            score *= 1.0 + (0.5 - gbm_bias) * 0.2;
        }

        let confidence = score.abs().min(1.0);

        // ── Decision Tree ────────────────────────────────────────────────────
        let tentative_action = if confidence >= cfg.min_confidence {
            if score > 0.0 && buy_count  >= cfg.min_agree { Direction::Buy  }
            else if score < 0.0 && sell_count >= cfg.min_agree { Direction::Sell }
            else { Direction::Wait }
        } else {
            Direction::Wait
        };

        // ── [FIX-C1] EMA TREND HARD VETO ─────────────────────────────────────
        // Dilakukan SETELAH decision tree agar hanya veto sinyal konkrit
        if let Some(veto_reason) = self.check_ema_trend_veto(
            tentative_action, snap.price, ema9, ema21, ema50, ema_bear, ema_bull
        ) {
            log::warn!("[Consensus] [FIX-C1] EMA VETO: {veto_reason}");
            return self.make_wait(votes, veto_reason, ts_ms);
        }

        let action = tentative_action;

        // ── [FIX-C4] TP/SL dengan minimum ATR floor ──────────────────────────
        // ATR minimum 0.2% dari price agar TP/SL tidak terlalu dekat
        let raw_atr = snap.atr_14;
        let min_atr = snap.price * 0.002; // 0.2% floor
        let atr     = raw_atr.max(min_atr); // [FIX-C4]
        let price   = snap.price;

        let (entry, tp, sl) = match action {
            Direction::Buy => {
                let e = price;
                let s = price - atr * cfg.sl_atr_mult;
                let t = liq_tp_above(snap, price, atr, cfg.tp_atr_mult * 1.5)
                    .unwrap_or(price + atr * cfg.tp_atr_mult);
                (e, t.max(e + atr * cfg.tp_atr_mult), s) // ensure TP > entry
            }
            Direction::Sell => {
                let e = price;
                let s = price + atr * cfg.sl_atr_mult;
                let t = liq_tp_below(snap, price, atr, cfg.tp_atr_mult * 1.5)
                    .unwrap_or(price - atr * cfg.tp_atr_mult);
                (e, t.min(e - atr * cfg.tp_atr_mult), s) // ensure TP < entry
            }
            Direction::Wait => (price, price, price),
        };

        let sl_dist = (entry - sl).abs().max(1e-8);
        let tp_dist = (tp    - entry).abs();
        let rr      = tp_dist / sl_dist;

        // [FIX-C4] Cek RR minimum — jika tidak memenuhi, return WAIT
        // (Go side juga cek RR, ini early rejection di Rust)
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
            "[Consensus] {:?} conf={:.3} BUY={buy_count} SELL={sell_count} score={score:.3} RR={rr:.2} EMA=({:.2},{:.2},{:.2}) bear={ema_bear} bull={ema_bull}",
            action, confidence, ema9, ema21, ema50
        );

        SignalOutput {
            action, confidence, entry, take_profit: tp, stop_loss: sl,
            risk_reward: rr, veto: false, veto_reason: String::new(),
            agent_dirs, agent_convictions, ts_ms,
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [FIX-C1] EMA TREND HARD VETO
    // Kondisi veto:
    //   BUY  + EMA bear-align (9<21<50) + price < EMA50 * 0.995  → VETO KERAS
    //   SELL + EMA bull-align (9>21>50) + price > EMA50 * 1.005  → VETO KERAS
    // Soft-conflict (EMA bear tapi price masih di atas EMA50) tidak di-veto
    // tapi sudah dihandle oleh dynamic weight dampening [FIX-C2]
    // ═══════════════════════════════════════════════════════════════════════
    fn check_ema_trend_veto(
        &self,
        action: Direction,
        price: f64,
        ema9: f64, ema21: f64, ema50: f64,
        ema_bear: bool, ema_bull: bool
    ) -> Option<String> {
        match action {
            Direction::Buy if ema_bear && price < ema50 * 0.995 => {
                Some(format!(
                    "[FIX-C1] BUY blocked: EMA bear-align (9={:.2} < 21={:.2} < 50={:.2}) + price={:.4} below EMA50*0.995={:.4} — LSR manipulation suspected",
                    ema9, ema21, ema50, price, ema50 * 0.995
                ))
            }
            Direction::Sell if ema_bull && price > ema50 * 1.005 => {
                Some(format!(
                    "[FIX-C1] SELL blocked: EMA bull-align (9={:.2} > 21={:.2} > 50={:.2}) + price={:.4} above EMA50*1.005={:.4} — fade signal suspected",
                    ema9, ema21, ema50, price, ema50 * 1.005
                ))
            }
            _ => None
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // [FIX-C2] DYNAMIC WEIGHT DAMPENING
    // Jika EMA alignment jelas bertentangan dengan absurdist (LSR-based) vote:
    //   - Absurdist weight dikurangi 70% (jadi hanya 30% dari aslinya)
    // Jika linguist punya sedikit artikel (< 3) → noise tinggi:
    //   - Linguist weight dikurangi 50%
    // Agent lain tidak diubah.
    // ═══════════════════════════════════════════════════════════════════════
    fn calc_effective_weights<'a>(
        &self,
        votes: &[AgentVote],
        snap: &MarketSnapshot,
        ema_bear: bool,
        ema_bull: bool,
    ) -> Vec<(&'a str, f64)> {
        let mut ew: Vec<(&str, f64)> = WEIGHTS.iter().map(|&(n, w)| (n, w)).collect();

        for (name, weight) in ew.iter_mut() {
            match *name {
                "absurdist" => {
                    // Cek apakah absurdist bertentangan dengan EMA
                    let abs_vote = votes.iter().find(|v| v.agent == "absurdist");
                    if let Some(vote) = abs_vote {
                        let conflicts = (ema_bear && vote.direction == Direction::Buy)
                            || (ema_bull && vote.direction == Direction::Sell);
                        if conflicts {
                            // [FIX-C2] Kurangi weight drastis — LSR tidak dipercaya
                            *weight *= ABSURDIST_DAMP;
                            log::debug!(
                                "[FIX-C2] Absurdist weight dampened {:.2}→{:.2} (EMA conflict)",
                                WEIGHTS.iter().find(|(n,_)| *n=="absurdist").map(|(_,w)|*w).unwrap_or(0.10),
                                *weight
                            );
                        }
                    }
                }
                "linguist" => {
                    // [FIX-C2] Jika data berita tipis, kurangi pengaruh linguist
                    if snap.news_count < 3 {
                        *weight *= LINGUIST_DAMP;
                    }
                }
                _ => {}
            }
        }
        ew
    }

    // VETO CHAIN lama — tetap dipertahankan (noise + volatility crisis)
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
                        "Market noise {noise:.3} > threshold {:.2} (style noise_veto)",
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
