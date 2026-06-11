// rust-brain/src/consensus/mod.rs
//
// [FIX-NOISE-SCALP] noise_veto 0.82 → 0.93 — log: noise=0.860 → veto terus
// [FIX-CONF-SCALP]  min_confidence 0.18 → 0.12, min_rr 1.2 → 0.8
// [FIX-NOISE-DAY]   noise_veto 0.68 → 0.78
// [FIX-NOISE-SWING] noise_veto 0.55 → 0.65
// [FIX-CONF]        baca bot_runtime.conf bukan .env (sudah ada, dipertahankan)

use crate::agents::{AgentVote, Direction};
use crate::evolution::EvolutionEngine;
use crate::shm::{MarketSnapshot, SignalOutput, AGENT_COUNT};
use chrono::Utc;
use std::collections::HashMap;
use std::sync::Mutex;






#[derive(Debug, Clone)]
#[allow(dead_code)]
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
    let mut search_paths: Vec<String> = Vec::new();
    // Check BOT_BASE_DIR first (D:\database\engine)
    if let Ok(base) = std::env::var("BOT_BASE_DIR") {
        search_paths.push(format!("{}/bot_runtime.conf", base));
    }
    search_paths.push("bot_runtime.conf".to_string());
    search_paths.push(".env".to_string());

    for filename in &search_paths {
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
    #[allow(dead_code)]
    Soft(f64),
}

#[derive(Debug, Clone)]
pub struct ShadowTrade {
    pub db_id: i64,
    pub entry_price: f64,
    pub tp: f64,
    pub sl: f64,
    pub direction: Direction,
    pub agent_votes: Vec<(String, Direction, f64)>,
    pub status: String,
}

pub struct ConsensusEngine {
    shadow_trades: Mutex<HashMap<String, Vec<ShadowTrade>>>,
    evolution: EvolutionEngine,
    db_client: std::sync::Arc<crate::db::DbClient>,
    is_live: bool,
}

impl ConsensusEngine {
    pub fn new(db_client: std::sync::Arc<crate::db::DbClient>, is_live: bool) -> Self {
        let evolution = EvolutionEngine::new(&[], db_client.clone());
        Self {
            shadow_trades: Mutex::new(HashMap::new()),
            evolution,
            db_client,
            is_live,
        }
    }

    pub fn get_positions(&self) -> HashMap<String, Vec<ShadowTrade>> {
        self.shadow_trades.lock().unwrap().clone()
    }

    pub fn process_shadow_trades(&self, snap: &MarketSnapshot, global_veto: bool) {
        let price = snap.price;
        let sym = std::str::from_utf8(&snap.symbol).unwrap_or("UNK").trim_end_matches('\0').to_string();
        
        let mut all_shadows = self.shadow_trades.lock().unwrap();
        if let Some(shadow_lock) = all_shadows.get_mut(&sym) {
            let mut i = 0;
            while i < shadow_lock.len() {
                let mut trade_finished = false;
                let mut is_win = false;
                
                // If global_veto is triggered, forcefully kill all PENDING and OPEN trades to mitigate risk.
                if global_veto {
                    shadow_lock[i].status = "VETO_KILLED".to_string();
                    log::warn!("[Room_Shadow] VETO DITEKAN! Membunuh secara paksa posisi {:?} limit @ {}", shadow_lock[i].direction, shadow_lock[i].entry_price);
                    trade_finished = true;
                    is_win = false; // Force loss or break-even logically
                } else if shadow_lock[i].status == "PENDING" {
                    if (shadow_lock[i].direction == Direction::Buy && price <= shadow_lock[i].entry_price) ||
                       (shadow_lock[i].direction == Direction::Sell && price >= shadow_lock[i].entry_price) {
                        shadow_lock[i].status = "OPEN".to_string();
                        log::info!("[Room_Shadow] Limit Order Kejemput! Status PENDING -> OPEN @ {}", shadow_lock[i].entry_price);
                    }
                } else if shadow_lock[i].status == "OPEN" {
                    if shadow_lock[i].direction == Direction::Buy {
                        if price >= shadow_lock[i].tp { trade_finished = true; is_win = true; }
                        else if price <= shadow_lock[i].sl { trade_finished = true; is_win = false; }
                    } else if shadow_lock[i].direction == Direction::Sell {
                        if price <= shadow_lock[i].tp { trade_finished = true; is_win = true; }
                        else if price >= shadow_lock[i].sl { trade_finished = true; is_win = false; }
                    }
                }

                if trade_finished {
                    let t = &shadow_lock[i];
                    let now_ms = Utc::now().timestamp_millis();
                    if self.is_live {
                        self.db_client.update_shadow_trade(t.db_id, now_ms, price, is_win);
                    }
                    if t.status == "VETO_KILLED" {
                        log::info!("[Room_Shadow] Shadow Trade (id={}) Dibatalkan oleh VETO Sistem.", t.db_id);
                    } else {
                        log::info!("[Room_Shadow] Shadow Trade Selesai (id={}). Win={}. Memicu evaluasi mandiri agen!", t.db_id, is_win);
                        
                        let sl_dist = (t.entry_price - t.sl).abs().max(1e-8);
                        let tp_dist = (t.tp - t.entry_price).abs();
                        let rr = tp_dist / sl_dist;
                        
                        let sym = std::str::from_utf8(&snap.symbol).unwrap_or("UNK").trim_end_matches('\0');
                        // FIX: Save the shadow trade result to the database as Paper Trade!
                        self.db_client.insert_trade_result(
                            t.db_id % 10000000000, // heuristic open_ts
                            now_ms,
                            sym,
                            if t.direction == Direction::Buy { "BUY" } else { "SELL" },
                            t.entry_price,
                            t.tp,
                            t.sl,
                            price,
                            is_win,
                            rr,
                            false, // is_real_money = false
                            true // is_shadow = true
                        );

                        let reports = self.evolution.on_trade_closed(
                            &t.agent_votes, t.direction, is_win, rr, now_ms,
                        );
                        for r in &reports {
                            let adj = if r.adjustments.is_empty() {
                                "no-change".to_string()
                            } else {
                                r.adjustments.join(", ")
                            };
                            log::info!("[Evolusi:{}] {} | {}", r.agent, r.verdict, adj);
                        }
                    }
                    shadow_lock.remove(i);
                } else {
                    i += 1;
                }
            }
        }
    }


    pub fn evaluate(&self, votes: &[AgentVote], snap: &MarketSnapshot, is_real_money: bool, tab_id: &str) -> SignalOutput {
        let ts_ms = Utc::now().timestamp_millis();
        let sym = std::str::from_utf8(&snap.symbol).unwrap_or("UNK").trim_end_matches(' ').to_string();
        let style_name = read_trading_style();
        let cfg = make_style_config(&style_name);

        log::info!("[Consensus] SNIPER MODE: style={} min_agree={} min_rr={}", cfg.style_name, cfg.min_agree, cfg.min_rr);

        let (ema9, ema21, ema50, ema_bear, ema_bull) = ema_alignment(snap);
        let performances = self.evolution.performance_snapshot();

        let mut buy_count = 0_usize;
        let mut sell_count = 0_usize;
        let mut is_vetoed = false;
        let mut final_veto_reason = String::new();
        let mut vote_details = Vec::new();
        let mut kicked_agents: Vec<String> = Vec::new();

        for vote in votes {
            let perf = performances.get(vote.agent);
            let wr = perf.map(|p| p.win_rate).unwrap_or(50.0);
            let trades = perf.map(|p| p.total_trades).unwrap_or(0);
            let w_streak = perf.map(|p| p.win_streak).unwrap_or(0);
            let l_streak = perf.map(|p| p.loss_streak).unwrap_or(0);

            // ═══ TATAR MILITER: KICK agent tolol ═══
            // Agent dengan WR<50% (min 10 trades) ATAU loss_streak>=3 → DITENDANG
            // Vote-nya TIDAK DIHITUNG sama sekali. Harus latihan dulu.
            if (trades >= 10 && wr < 50.0) || l_streak >= 3 {
                log::warn!(
                    "[TATAR] KICKED! {} WR={:.1}% trades={} loss_streak={} → Vote DIABAIKAN, kirim ke pelatihan!",
                    vote.agent, wr, trades, l_streak
                );
                kicked_agents.push(vote.agent.to_string());
                continue; // SKIP — agent ini tidak boleh vote
            }

            // ═══ VETO: hanya untuk agent WR>50% ATAU win_streak>=2 ═══
            let can_veto = (trades >= 10 && wr > 50.0) || w_streak >= 2;

            match vote.direction {
                Direction::Buy => {
                    vote_details.push((vote.agent.to_string(), Direction::Buy, vote.conviction));
                    buy_count += 1;
                }
                Direction::Sell => {
                    vote_details.push((vote.agent.to_string(), Direction::Sell, vote.conviction));
                    sell_count += 1;
                }
                // SEMUA vote non-directional (Veto/Wait/Hold):
                // Hanya agent berkualitas yang boleh VETO.
                // Agent lain DIPAKSA pilih LONG/SHORT berdasarkan EMA.
                _ => {
                    if can_veto {
                        is_vetoed = true;
                        final_veto_reason = format!("{} sah VETO (WR={:.1}% streak={}): {}", vote.agent, wr, w_streak, vote.reasoning);
                        log::warn!("[VETO SAH] {}", final_veto_reason);
                    } else {
                        // PAKSA pilih LONG/SHORT berdasarkan EMA trend
                        let forced_dir = if ema_bull {
                            Direction::Buy
                        } else if ema_bear {
                            Direction::Sell
                        } else if snap.price > ema50 {
                            Direction::Buy
                        } else {
                            Direction::Sell
                        };
                        log::warn!(
                            "[PAKSA VOTE] {} mencoba {:?} tapi WR={:.1}%. DIPAKSA {:?}!",
                            vote.agent, vote.direction, wr, forced_dir
                        );
                        vote_details.push((vote.agent.to_string(), forced_dir.clone(), 0.3));
                        if forced_dir == Direction::Buy {
                            buy_count += 1;
                        } else {
                            sell_count += 1;
                        }
                    }
                }
            }
        }

        if !kicked_agents.is_empty() {
            log::info!("[TATAR] {} agent ditendang dari voting: {:?}", kicked_agents.len(), kicked_agents);
        }

        let bypass_limits = tab_id == "Signal_API";
        let req_agree = if bypass_limits { 1 } else { cfg.min_agree };

        // Simple majority — NO weight system. Equal vote per active agent.
        let mut tentative_action = if is_vetoed {
            Direction::Veto
        } else if buy_count > sell_count && buy_count >= req_agree {
            Direction::Buy
        } else if sell_count > buy_count && sell_count >= req_agree {
            Direction::Sell
        } else if buy_count == sell_count && buy_count >= req_agree {
            // Tie-break: follow EMA trend
            if ema_bull { Direction::Buy } else { Direction::Sell }
        } else {
            is_vetoed = true;
            final_veto_reason = format!(
                "Tim agen buntu (BUY={} vs SELL={})",
                buy_count, sell_count
            );
            Direction::Veto
        };

        let strong_consensus = (tentative_action == Direction::Buy && buy_count >= 4)
                            || (tentative_action == Direction::Sell && sell_count >= 4);

        log::info!(
            "[Consensus] MAJORITY: BUY={} SELL={} kicked={} | Decision={:?} strong={}",
            buy_count, sell_count, kicked_agents.len(), tentative_action, strong_consensus
        );

        let raw_atr = snap.atr_14;
        let min_atr = snap.price * 0.002;
        let atr     = raw_atr.max(min_atr);
        let price   = snap.price;

        let calc_targets = |dir: Direction| -> (f64, f64, f64) {
            match dir {
                Direction::Buy => {
                    let e = price - atr * 0.3;
                    let s = e - atr * cfg.sl_atr_mult;
                    let t = liq_tp_above(snap, e, atr, cfg.tp_atr_mult * 1.5).unwrap_or(e + atr * cfg.tp_atr_mult);
                    (e, t.max(e + atr * cfg.tp_atr_mult), s)
                }
                Direction::Sell => {
                    let e = price + atr * 0.3;
                    let s = e + atr * cfg.sl_atr_mult;
                    let t = liq_tp_below(snap, e, atr, cfg.tp_atr_mult * 1.5).unwrap_or(e - atr * cfg.tp_atr_mult);
                    (e, t.min(e - atr * cfg.tp_atr_mult), s)
                }
                Direction::Veto => (price, price, price),
            }
        };

        let (entry, tp, sl) = calc_targets(tentative_action);

        if tentative_action != Direction::Veto && !bypass_limits {
            let quant_veto = self.check_quant_veto(tentative_action, snap);
            match quant_veto {
                QuantVetoResult::Hard(ref reason) => {
                    is_vetoed = true;
                    final_veto_reason = reason.clone();
                    tentative_action = Direction::Veto;
                }
                _ => {}
            }
        }

        let sl_dist = (entry - sl).abs().max(1e-8);
        let tp_dist = (tp - entry).abs();
        let rr = tp_dist / sl_dist;

        if tentative_action != Direction::Veto && !bypass_limits && rr < cfg.min_rr {
            is_vetoed = true;
            final_veto_reason = format!("Untungnya kekecilan, mending gausah (RR={:.2} < minimal {:.2})", rr, cfg.min_rr);
            tentative_action = Direction::Veto;
        }

        if tentative_action != Direction::Veto {
            let reason = if is_vetoed { final_veto_reason.clone() } else { "ACCEPTED".to_string() };
            let shadow_id = self.db_client.insert_shadow_trade(ts_ms, &sym, if tentative_action == Direction::Buy { "BUY" } else { "SELL" }, entry, tp, sl, &reason, is_real_money);
            if shadow_id > 0 {
                let st = ShadowTrade { 
                    db_id: shadow_id, entry_price: entry, tp, sl, direction: tentative_action, 
                    agent_votes: vote_details.clone(), status: "PENDING".to_string() 
                };
                self.shadow_trades.lock().unwrap().entry(sym.clone()).or_default().push(st);
            }
        }

        let confidence = if is_vetoed { 0.0 } else { 1.0 }; // Pure Sniper, no confidence scale anymore!

        if tentative_action == Direction::Veto {
            return self.make_wait(votes, final_veto_reason, ts_ms);
        }
        
        let action = tentative_action;

        let mut agent_dirs        = [0u8; AGENT_COUNT];
        let mut agent_convictions = [0.0f64; AGENT_COUNT];
        for (i, vote) in votes.iter().take(AGENT_COUNT).enumerate() {
            agent_dirs[i]        = vote.direction as u8;
            agent_convictions[i] = vote.conviction;
        }

        let treasury = crate::agents::treasury_manager::TreasuryManager;
        let allocation_pct = if !is_vetoed {
            treasury.calculate_allocation(snap, confidence, rr, strong_consensus, &cfg.style_name)
        } else {
            0.0
        };

        log::info!(
            "[Otak-AI-Sniper] {:?} BUY={} SELL={} RR={:.2} Alloc={:.1}% style={} EMA=({:.2},{:.2},{:.2}) bear={} bull={}",
            action, buy_count, sell_count, rr, allocation_pct * 100.0, cfg.style_name, ema9, ema21, ema50, ema_bear, ema_bull
        );

        SignalOutput {
            action, confidence, entry, take_profit: tp, stop_loss: sl, risk_reward: rr,
            allocation_pct, veto: is_vetoed, veto_reason: final_veto_reason,
            agent_dirs, agent_convictions, ts_ms,
        }
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
            Direction::Veto => QuantVetoResult::Clear,
        }
    }



    fn make_wait(&self, votes: &[AgentVote], reason: String, ts_ms: i64) -> SignalOutput {
        let mut agent_dirs        = [0u8; AGENT_COUNT];
        let mut agent_convictions = [0.0f64; AGENT_COUNT];
        for (i, v) in votes.iter().take(AGENT_COUNT).enumerate() {
            agent_dirs[i]        = v.direction as u8;
            agent_convictions[i] = v.conviction;
        }
        SignalOutput {
            action: Direction::Veto,
            confidence: 0.0,
            entry: 0.0, take_profit: 0.0, stop_loss: 0.0, risk_reward: 0.0,
            allocation_pct: 0.0,
            veto: true,
            veto_reason: reason,
            agent_dirs,
            agent_convictions,
            ts_ms,
        }
    }
}

#[allow(dead_code)]
fn extract_gbm_bias(votes: &[AgentVote]) -> f64 {
    votes.iter()
        .find(|v| v.agent == "physicist")
        .and_then(|v| parse_f64_field(&v.reasoning, "upside_bias="))
        .unwrap_or(0.5)
}

#[allow(dead_code)]
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
    candidates.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
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
    candidates.sort_unstable_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    Some(candidates[candidates.len() / 4])
}
