// rust-brain/src/evolution/mod.rs
//
// ── TEAM-ANALISA SELF-EVALUATION FRAMEWORK ───────────────────────────────────
//
// Pendekatan kuantitatif (ala Renaissance / Jim Simons): tiap agent diperlakukan
// sebagai "sinyal" yang punya track-record terukur. Bobot dan agresivitasnya
// TIDAK statis — mereka beradaptasi terus-menerus berdasarkan hasil nyata.
//
// Desain ini SENGAJA terpusat & generik supaya:
//   1. SELURUH agent yang sudah ada tetap dipakai tanpa ditulis ulang.
//   2. Menambah agent baru cukup daftarkan namanya di `defaults` — framework
//      otomatis bikin scorecard + tunable adaptif untuknya. Tidak ada perubahan
//      arsitektur besar.
//   3. Format evaluasi & pelaporan SAMA untuk semua agent (konsisten).
//
// Mekanisme inti:
//   • Setiap trade ditutup (TP/SL) memicu `on_trade_closed`.
//   • Kalau LOSS (atau metrik agent memburuk) -> agent melakukan EVALUASI MANDIRI:
//       - menyesuaikan `weight`            (kontribusi suara di consensus)
//       - menyesuaikan `conviction_scale`  (seberapa "berani" dia bersuara)
//       - menaikkan  `activation_gate`     (ambang minimal agar suaranya dihitung)
//     dan menghasilkan `EvaluationReport` terstruktur.
//   • Level TEAM: kalau agregasi hasil memburuk (loss-streak / drawdown),
//     `conservatism_bias` naik -> consensus jadi lebih konservatif otomatis.
//
// Semua state dipersist ke `agent_evolution.json`. Untuk kompatibilitas mundur,
// peta bobot datar tetap ditulis ke `agent_rl_weights.json`.

use crate::agents::Direction;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;
use rusqlite::Connection;
use std::sync::mpsc;
use std::thread;

pub const EVOLUTION_FILE: &str = "agent_evolution.json";
pub const LEGACY_WEIGHTS_FILE: &str = "agent_rl_weights.json";

const MAX_RECENT: usize = 20;
const MAX_RECENT_PNL: usize = 50; // rolling window untuk recent-accuracy
const MAX_REPORTS: usize = 60; // ring-buffer laporan evaluasi
const BASE_LR: f64 = 0.05; // learning-rate dasar

const WEIGHT_MIN: f64 = 0.01;
const WEIGHT_MAX: f64 = 1.0;
const CONV_SCALE_MIN: f64 = 0.30;
const CONV_SCALE_MAX: f64 = 1.30;
const GATE_MAX: f64 = 0.60;

// ── Tunable adaptif per-agent ────────────────────────────────────────────────
// `params` sengaja generik (HashMap) supaya agent baru bisa mengekspos
// threshold internalnya sendiri (mis. "rsi_overbought", "z_entry") tanpa
// mengubah struct ini.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTunables {
    pub weight: f64,
    pub conviction_scale: f64,
    pub activation_gate: f64,
    #[serde(default)]
    pub params: HashMap<String, f64>,
}

impl Default for AgentTunables {
    fn default() -> Self {
        Self {
            weight: 0.10,
            conviction_scale: 1.0,
            activation_gate: 0.0,
            params: HashMap::new(),
        }
    }
}

// ── Track-record kuantitatif per-agent ───────────────────────────────────────
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentScorecard {
    pub trades: u64,
    pub correct: u64,
    pub incorrect: u64,
    pub accuracy: f64,
    pub recent_accuracy: f64,
    pub expected_value: f64, // EV dari MAX_RECENT_PNL
    pub pnl_contrib: f64,
    pub wrong_streak: u32,
    #[serde(default)]
    pub recent: Vec<bool>, 
    #[serde(default)]
    pub recent_pnl: Vec<f64>,
}

// ── Laporan evaluasi (format SAMA untuk semua agent) ─────────────────────────
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvaluationReport {
    pub agent: String,
    pub ts_ms: i64,
    pub trigger: String, // "trade_loss" | "trade_win" | "team_drawdown"
    pub trade_direction: String,
    pub agent_vote: String,
    pub was_correct: bool,
    pub verdict: String,
    pub adjustments: Vec<String>,
    pub weight_before: f64,
    pub weight_after: f64,
    pub conviction_scale_before: f64,
    pub conviction_scale_after: f64,
    pub activation_gate_before: f64,
    pub activation_gate_after: f64,
    pub accuracy: f64,
    pub recent_accuracy: f64,
    pub expected_value: f64,
}

// ── Scorecard level-team (agregasi) ──────────────────────────────────────────
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TeamScorecard {
    pub trades: u64,
    pub wins: u64,
    pub losses: u64,
    pub net_pnl_r: f64,
    pub peak_r: f64,
    pub drawdown_r: f64,
    pub win_streak: u32,
    pub loss_streak: u32,
    pub conservatism_bias: f64,
    pub expected_value: f64,
    #[serde(default)]
    pub recent_results: Vec<bool>,
    #[serde(default)]
    pub recent_pnl: Vec<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentRecord {
    pub tunables: AgentTunables,
    pub scorecard: AgentScorecard,
    #[serde(default)]
    pub last_report: Option<EvaluationReport>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EvolutionState {
    pub version: u32,
    pub updated_ms: i64,
    pub agents: HashMap<String, AgentRecord>,
    pub team: TeamScorecard,
    #[serde(default)]
    pub reports: Vec<EvaluationReport>,
}

pub struct EvolutionEngine {
    state: Mutex<EvolutionState>,
    tx: mpsc::Sender<EvolutionState>,
}

impl EvolutionEngine {
    /// `defaults` = daftar (nama_agent, bobot_awal). Menambah agent baru cukup
    /// menambahkan entri di sini (atau di WEIGHTS consensus) — framework otomatis
    /// menyiapkan scorecard + tunable-nya.
    
    pub fn new(defaults: &[(&str, f64)]) -> Self {
        let conn = Connection::open("agent_evolution.db").unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "synchronous", "NORMAL").unwrap();

        conn.execute("CREATE TABLE IF NOT EXISTS agents (name TEXT PRIMARY KEY, tunables_json TEXT, scorecard_json TEXT, last_report_json TEXT)", []).unwrap();
        conn.execute("CREATE TABLE IF NOT EXISTS team (id INTEGER PRIMARY KEY, team_json TEXT)", []).unwrap();
        conn.execute("CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY AUTOINCREMENT, report_json TEXT)", []).unwrap();

        let mut state = EvolutionState::default();
        state.version = 1;

        if let Ok(mut stmt) = conn.prepare("SELECT name, tunables_json, scorecard_json, last_report_json FROM agents") {
            if let Ok(agent_iter) = stmt.query_map([], |row| {
                let name: String = row.get(0)?;
                let t_json: String = row.get(1)?;
                let s_json: String = row.get(2)?;
                let r_json: Option<String> = row.get(3)?;
                
                let tunables = serde_json::from_str(&t_json).unwrap_or_default();
                let scorecard = serde_json::from_str(&s_json).unwrap_or_default();
                let last_report = r_json.and_then(|j| serde_json::from_str(&j).ok());
                
                Ok((name, AgentRecord { tunables, scorecard, last_report }))
            }) {
                for a in agent_iter {
                    if let Ok((name, rec)) = a {
                        state.agents.insert(name, rec);
                    }
                }
            }
        }

        if let Ok(team_json) = conn.query_row("SELECT team_json FROM team WHERE id=1", [], |row| row.get::<_, String>(0)) {
            state.team = serde_json::from_str(&team_json).unwrap_or_default();
        }

        if let Ok(mut stmt) = conn.prepare("SELECT report_json FROM reports ORDER BY id DESC LIMIT 60") {
            if let Ok(reports_iter) = stmt.query_map([], |row| {
                let j: String = row.get(0)?;
                Ok(serde_json::from_str(&j).ok())
            }) {
                for r in reports_iter {
                    if let Ok(Some(report)) = r {
                        state.reports.push(report);
                    }
                }
                state.reports.reverse();
            }
        }

        let legacy = Self::load_legacy_weights();

        for (name, w) in defaults {
            if !state.agents.contains_key(*name) {
                let mut rec = AgentRecord::default();
                rec.tunables.weight = legacy.get(*name).copied().unwrap_or(*w);
                state.agents.insert((*name).to_string(), rec);
                log::info!(
                    "[Evolution] Agent '{}' didaftarkan (seed weight={:.3}).",
                    name,
                    rec_weight(&state, name)
                );
            }
        }

        log::info!(
            "[Evolution] Loaded: {} agents, team trades={} net={:.1}R bias={:.3}",
            state.agents.len(),
            state.team.trades,
            state.team.net_pnl_r,
            state.team.conservatism_bias
        );

        let (tx, rx) = mpsc::channel::<EvolutionState>();
        thread::spawn(move || {
            let mut conn = Connection::open("agent_evolution.db").unwrap();
            conn.pragma_update(None, "journal_mode", "WAL").unwrap();
            conn.pragma_update(None, "synchronous", "NORMAL").unwrap();

            while let Ok(s) = rx.recv() {
                if let Ok(tx_db) = conn.transaction() {
                    for (name, rec) in &s.agents {
                        let t_json = serde_json::to_string(&rec.tunables).unwrap();
                        let s_json = serde_json::to_string(&rec.scorecard).unwrap();
                        let r_json = rec.last_report.as_ref().map(|r| serde_json::to_string(r).unwrap());
                        
                        let _ = tx_db.execute(
                            "INSERT OR REPLACE INTO agents (name, tunables_json, scorecard_json, last_report_json) VALUES (?1, ?2, ?3, ?4)",
                            (name, &t_json, &s_json, &r_json),
                        );
                    }

                    if let Ok(team_json) = serde_json::to_string(&s.team) {
                        let _ = tx_db.execute(
                            "INSERT OR REPLACE INTO team (id, team_json) VALUES (1, ?1)",
                            (&team_json,),
                        );
                    }

                    let _ = tx_db.execute("DELETE FROM reports", []);
                    for r in &s.reports {
                        if let Ok(j) = serde_json::to_string(r) {
                            let _ = tx_db.execute("INSERT INTO reports (report_json) VALUES (?1)", (&j,));
                        }
                    }

                    let _ = tx_db.commit();
                }
            }
        });

        Self {
            state: Mutex::new(state),
            tx,
        }
    }

    fn load_legacy_weights() -> HashMap<String, f64> {

        fs::read_to_string(LEGACY_WEIGHTS_FILE)
            .ok()
            .and_then(|d| serde_json::from_str::<HashMap<String, f64>>(&d).ok())
            .unwrap_or_default()
    }

    /// Snapshot tunable semua agent — dipanggil consensus sekali per evaluasi
    /// supaya tidak lock berulang dalam loop.
    pub fn tunables_snapshot(&self) -> HashMap<String, AgentTunables> {
        let s = self.state.lock().unwrap();
        s.agents
            .iter()
            .map(|(k, v)| (k.clone(), v.tunables.clone()))
            .collect()
    }

    /// Bias konservatisme team — ditambahkan ke min_confidence consensus.
        pub fn team_expected_value(&self) -> f64 {
        self.state.lock().unwrap().team.expected_value
    }
    
    pub fn team_recent_pnl(&self) -> Vec<f64> {
        self.state.lock().unwrap().team.recent_pnl.clone()
    }

    pub fn team_kelly_stats(&self) -> (f64, f64) {
        let s = self.state.lock().unwrap();
        let w = if s.team.trades > 0 {
            s.team.wins as f64 / s.team.trades as f64
        } else {
            0.5
        };
        let mut sum_r = 0.0;
        let mut count_r = 0.0;
        for &p in &s.team.recent_pnl {
            if p > 0.0 {
                sum_r += p;
                count_r += 1.0;
            }
        }
        let r = if count_r > 0.0 { sum_r / count_r } else { 1.0 };
        (w, r)
    }

    pub fn conservatism_bias(&self) -> f64 {
        self.state.lock().unwrap().team.conservatism_bias
    }

    /// Dipanggil consensus saat sebuah trade ditutup (TP/SL).
    /// Mengembalikan laporan evaluasi yang dihasilkan (untuk di-log).
    pub fn on_trade_closed(
        &self,
        votes: &[(String, Direction, f64)],
        trade_direction: Direction,
        is_win: bool,
        rr: f64,
        ts_ms: i64,
    ) -> Vec<EvaluationReport> {
        let mut state = self.state.lock().unwrap();
        let mut emitted: Vec<EvaluationReport> = Vec::new();

        // ── 1) Agregasi level-team ───────────────────────────────────────────
        state.team.trades += 1;
        if is_win {
            state.team.wins += 1;
            state.team.win_streak += 1;
            state.team.loss_streak = 0;
            state.team.net_pnl_r += rr.max(0.1);
        } else {
            state.team.losses += 1;
            state.team.loss_streak += 1;
            state.team.win_streak = 0;
            state.team.net_pnl_r -= 1.0;
        }
        push_capped(&mut state.team.recent_results, is_win);
        push_capped_pnl(&mut state.team.recent_pnl, if is_win { rr.max(0.1) } else { -1.0 });
        state.team.expected_value = calc_ev(&state.team.recent_pnl);
        if state.team.net_pnl_r > state.team.peak_r {
            state.team.peak_r = state.team.net_pnl_r;
        }
        state.team.drawdown_r = (state.team.peak_r - state.team.net_pnl_r).max(0.0);

        // Conservatism bias: naik saat loss beruntun, meluruh saat menang.
        if is_win {
            state.team.conservatism_bias *= 0.5;
            if state.team.conservatism_bias < 0.005 {
                state.team.conservatism_bias = 0.0;
            }
        } else if state.team.loss_streak >= 2 {
            let target = ((state.team.loss_streak as f64 - 1.0) * 0.03).min(0.15);
            if target > state.team.conservatism_bias {
                state.team.conservatism_bias = target;
            }
        }

        // Evaluasi mandiri level-team saat agregasi memburuk.
        if !is_win && state.team.loss_streak >= 2 {
            let acc = state.team.wins as f64 / state.team.trades.max(1) as f64;
            let rec_acc = recent_rate(&state.team.recent_results);
            let report = EvaluationReport {
                agent: "__team__".to_string(),
                ts_ms,
                trigger: "team_drawdown".to_string(),
                trade_direction: dir_str(trade_direction),
                agent_vote: "-".to_string(),
                was_correct: false,
                verdict: format!(
                    "Loss-streak {} (drawdown {:.1}R). Team naikin konservatisme ke {:.3} \u{2014} min_confidence consensus jadi lebih ketat otomatis.",
                    state.team.loss_streak, state.team.drawdown_r, state.team.conservatism_bias
                ),
                adjustments: vec![format!(
                    "conservatism_bias -> {:.3}",
                    state.team.conservatism_bias
                )],
                weight_before: 0.0,
                weight_after: 0.0,
                conviction_scale_before: 0.0,
                conviction_scale_after: 0.0,
                activation_gate_before: 0.0,
                activation_gate_after: 0.0,
                accuracy: acc,
                recent_accuracy: rec_acc,
                expected_value: state.team.expected_value,
            };
            emitted.push(report);
        }

        // ── 2) Evaluasi mandiri tiap agent yang ikut bersuara ────────────────
        for (agent, vote_dir, conv) in votes {
            if *vote_dir == Direction::Wait {
                continue;
            }
            let rec = state
                .agents
                .entry(agent.clone())
                .or_insert_with(AgentRecord::default);

            // "Benar" secara kuantitatif:
            //   - menang & searah trade           -> benar (ikut cuan)
            //   - kalah & searah trade            -> salah (ikut nyangkut)
            //   - menang & lawan arah trade       -> salah (ketinggalan)
            //   - kalah & lawan arah trade        -> benar (nyelametin)
            let agreed = *vote_dir == trade_direction;
            let was_correct = agreed == is_win;

            rec.scorecard.trades += 1;
            if was_correct {
                rec.scorecard.correct += 1;
                rec.scorecard.wrong_streak = 0;
            } else {
                rec.scorecard.incorrect += 1;
                rec.scorecard.wrong_streak += 1;
            }
            push_capped(&mut rec.scorecard.recent, was_correct);
            
            let pnl_this_trade = if agreed {
                if is_win { rr.max(0.1) } else { -1.0 }
            } else {
                0.0
            };
            
            if agreed {
                push_capped_pnl(&mut rec.scorecard.recent_pnl, pnl_this_trade);
            }
            
            rec.scorecard.accuracy = rec.scorecard.correct as f64 / rec.scorecard.trades.max(1) as f64;
            rec.scorecard.recent_accuracy = recent_rate(&rec.scorecard.recent);
            rec.scorecard.expected_value = calc_ev(&rec.scorecard.recent_pnl);
            rec.scorecard.pnl_contrib += pnl_this_trade;

            let before_w = rec.tunables.weight;
            let before_cs = rec.tunables.conviction_scale;
            let before_ag = rec.tunables.activation_gate;

            let lr = BASE_LR * conv.max(0.05);
            let mut adjustments: Vec<String> = Vec::new();

            // Adaptasi bobot berdasarkan PROPORTIONAL R/R:
            let dw = if agreed && is_win {
                lr * rr.clamp(0.1, 5.0) // reward proporsional thd RR
            } else if agreed && !is_win {
                -lr * 1.5 
            } else if !agreed && is_win {
                -lr * 0.5 
            } else {
                lr * 0.5 
            };
            rec.tunables.weight = (rec.tunables.weight + dw).clamp(WEIGHT_MIN, WEIGHT_MAX);
            if (rec.tunables.weight - before_w).abs() > 1e-9 {
                adjustments.push(format!("weight {:+.4} -> {:.4}", dw, rec.tunables.weight));
            }

            // Self-evaluation: Gunakan Expected Value sebagai penentu
            if !was_correct {
                if rec.scorecard.expected_value < 0.0 {
                    rec.tunables.activation_gate =
                        (rec.tunables.activation_gate + 0.05).min(GATE_MAX);
                    rec.tunables.conviction_scale =
                        (rec.tunables.conviction_scale - 0.05).max(CONV_SCALE_MIN);
                    adjustments.push(format!(
                        "activation_gate -> {:.3}",
                        rec.tunables.activation_gate
                    ));
                    adjustments.push(format!(
                        "conviction_scale -> {:.3}",
                        rec.tunables.conviction_scale
                    ));
                } else {
                    rec.tunables.conviction_scale =
                        (rec.tunables.conviction_scale - 0.02).max(CONV_SCALE_MIN);
                    adjustments.push(format!(
                        "conviction_scale -> {:.3}",
                        rec.tunables.conviction_scale
                    ));
                }
            } else if rec.scorecard.expected_value > 0.20 {
                // Track-record bagus -> pulihkan keberanian & buka gate pelan-pelan.
                let cs = (rec.tunables.conviction_scale + 0.02).min(CONV_SCALE_MAX);
                let ag = (rec.tunables.activation_gate - 0.02).max(0.0);
                if (cs - before_cs).abs() > 1e-9 {
                    rec.tunables.conviction_scale = cs;
                    adjustments.push(format!("conviction_scale -> {:.3}", cs));
                }
                if (ag - before_ag).abs() > 1e-9 {
                    rec.tunables.activation_gate = ag;
                    adjustments.push(format!("activation_gate -> {:.3}", ag));
                }
            }

            let verdict = build_verdict(agent, agreed, is_win, was_correct, &rec.scorecard);
            let report = EvaluationReport {
                agent: agent.clone(),
                ts_ms,
                trigger: if is_win {
                    "trade_win".to_string()
                } else {
                    "trade_loss".to_string()
                },
                trade_direction: dir_str(trade_direction),
                agent_vote: dir_str(*vote_dir),
                was_correct,
                verdict,
                adjustments,
                weight_before: before_w,
                weight_after: rec.tunables.weight,
                conviction_scale_before: before_cs,
                conviction_scale_after: rec.tunables.conviction_scale,
                activation_gate_before: before_ag,
                activation_gate_after: rec.tunables.activation_gate,
                accuracy: rec.scorecard.accuracy,
                recent_accuracy: rec.scorecard.recent_accuracy,
                expected_value: rec.scorecard.expected_value,
            };
            rec.last_report = Some(report.clone());

            // Trigger pelaporan utama = LOSS. Saat menang cukup simpan last_report.
            if !is_win {
                emitted.push(report);
            }
        }

        // ── 3) Ring-buffer laporan + persist ─────────────────────────────────
        for r in &emitted {
            state.reports.push(r.clone());
        }
        let len = state.reports.len();
        if len > MAX_REPORTS {
            state.reports.drain(0..len - MAX_REPORTS);
        }
        state.updated_ms = ts_ms;

        
        Self::persist(&state, &self.tx);
        emitted
    }

    fn persist(state: &EvolutionState, tx: &mpsc::Sender<EvolutionState>) {
        let _ = tx.send(state.clone());
    }
}


// ── Helpers ──────────────────────────────────────────────────────────────────

fn rec_weight(state: &EvolutionState, name: &str) -> f64 {
    state
        .agents
        .get(name)
        .map(|r| r.tunables.weight)
        .unwrap_or(0.10)
}

fn dir_str(d: Direction) -> String {
    match d {
        Direction::Buy => "BUY".to_string(),
        Direction::Sell => "SELL".to_string(),
        Direction::Wait => "WAIT".to_string(),
    }
}

fn push_capped_pnl(v: &mut Vec<f64>, val: f64) {
    v.push(val);
    let len = v.len();
    if len > MAX_RECENT_PNL {
        v.drain(0..len - MAX_RECENT_PNL);
    }
}

fn calc_ev(v: &[f64]) -> f64 {
    if v.is_empty() { return 0.0; }
    v.iter().sum::<f64>() / v.len() as f64
}

fn push_capped(v: &mut Vec<bool>, val: bool) {
    v.push(val);
    let len = v.len();
    if len > MAX_RECENT {
        v.drain(0..len - MAX_RECENT);
    }
}

fn recent_rate(v: &[bool]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.iter().filter(|&&b| b).count() as f64 / v.len() as f64
}

fn build_verdict(
    agent: &str,
    agreed: bool,
    is_win: bool,
    was_correct: bool,
    sc: &AgentScorecard,
) -> String {
    let outcome = if is_win { "WIN" } else { "LOSS" };
    let role = match (agreed, is_win) {
        (true, true) => "ikut trade yang menang",
        (true, false) => "ikut trade yang kalah (nyumbang loss)",
        (false, true) => "nolak trade yang ternyata menang (ketinggalan)",
        (false, false) => "nolak trade yang kalah (bantu nyelametin)",
    };
    format!(
        "Trade {outcome}: {agent} {role}. Self-eval -> {}. acc={:.0}% EV={:.2}R wrong_streak={}",
        if was_correct {
            "perkuat sinyal"
        } else {
            "ketatkan threshold"
        },
        sc.accuracy * 100.0,
        sc.expected_value,
        sc.wrong_streak
    )
}
