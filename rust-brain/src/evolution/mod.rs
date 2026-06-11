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
use std::sync::{Arc, Mutex};
use crate::db::DbClient;

pub mod gatekeeper;

const MAX_RECENT: usize = 20; // rolling window untuk recent-accuracy
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
pub struct AgentPerformance {
    #[serde(rename = "totalTrades")]
    pub total_trades: u64,
    #[serde(rename = "winRate")]
    pub win_rate: f64,
    #[serde(rename = "winStreak")]
    pub win_streak: u32,
    #[serde(rename = "lossStreak")]
    pub loss_streak: u32,
    pub pnl_contrib: f64,
    #[serde(default)]
    pub recent: Vec<bool>,
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
    pub conservatism_bias: f64, // ditambahkan ke min_confidence consensus
    #[serde(default)]
    pub recent_results: Vec<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentRecord {
    pub tunables: AgentTunables,
    pub performance: AgentPerformance,
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
    db_client: Arc<DbClient>,
}

impl EvolutionEngine {
    /// `defaults` = daftar (nama_agent, bobot_awal). Menambah agent baru cukup
    /// menambahkan entri di sini (atau di WEIGHTS consensus) — framework otomatis
    /// menyiapkan scorecard + tunable-nya.
    pub fn new(defaults: &[(&str, f64)], db_client: Arc<DbClient>) -> Self {
        let mut state = Self::load_state(&db_client).unwrap_or_default();
        state.version = 1;

        let legacy = Self::load_legacy_weights();

        for (name, w) in defaults {
            if !state.agents.contains_key(*name) {
                let mut rec = AgentRecord::default();
                // Seed bobot: pakai file lama kalau ada, kalau tidak pakai default.
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

        Self {
            state: Mutex::new(state),
            db_client,
        }
    }

    fn load_state(db: &DbClient) -> Option<EvolutionState> {
        let data = db.load_evolution_state()?;
        serde_json::from_str(&data).ok()
    }

    fn load_legacy_weights() -> HashMap<String, f64> {
        HashMap::new() // No longer load from JSON
    }

    /// Snapshot tunable semua agent — dipanggil consensus sekali per evaluasi
    /// supaya tidak lock berulang dalam loop.
    #[allow(dead_code)]
pub fn tunables_snapshot(&self) -> HashMap<String, AgentTunables> {
        let s = self.state.lock().unwrap();
        s.agents
            .iter()
            .map(|(k, v)| (k.clone(), v.tunables.clone()))
            .collect()
    }

    /// Bias konservatisme team — ditambahkan ke min_confidence consensus.
    #[allow(dead_code)]
pub fn conservatism_bias(&self) -> f64 {
        self.state.lock().unwrap().team.conservatism_bias
    }

    pub fn performance_snapshot(&self) -> HashMap<String, AgentPerformance> {
        self.state.lock().unwrap().agents.iter()
            .map(|(k, v)| (k.clone(), v.performance.clone()))
            .collect()
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
            };
            emitted.push(report);
        }

        // ── 2) Evaluasi mandiri tiap agent yang ikut bersuara ────────────────
        for (agent, vote_dir, conv) in votes {
            if *vote_dir == Direction::Veto {
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

            rec.performance.total_trades += 1;
            if was_correct {
                rec.performance.win_streak += 1;
                rec.performance.loss_streak = 0;
            } else {
                rec.performance.loss_streak += 1;
                rec.performance.win_streak = 0;
            }
            push_capped(&mut rec.performance.recent, was_correct);
            rec.performance.win_rate = recent_rate(&rec.performance.recent) * 100.0;
            rec.performance.pnl_contrib += if agreed {
                if is_win {
                    rr.max(0.1)
                } else {
                    -1.0
                }
            } else {
                0.0
            };

            let before_w = rec.tunables.weight;
            let before_cs = rec.tunables.conviction_scale;
            let before_ag = rec.tunables.activation_gate;

            let lr = BASE_LR * conv.max(0.05);
            let mut adjustments: Vec<String> = Vec::new();

            // Adaptasi bobot (aturan konsisten untuk semua agent):
            let dw = if agreed && is_win {
                lr // reward: ikut trade menang
            } else if agreed && !is_win {
                -lr * 1.5 // punish keras: ikut trade kalah
            } else if !agreed && is_win {
                -lr * 0.5 // punish ringan: nolak trade menang
            } else {
                lr * 0.5 // reward ringan: nolak trade kalah (nyelametin)
            };
            rec.tunables.weight = (rec.tunables.weight + dw).clamp(WEIGHT_MIN, WEIGHT_MAX);
            if (rec.tunables.weight - before_w).abs() > 1e-9 {
                adjustments.push(format!("weight {:+.4} -> {:.4}", dw, rec.tunables.weight));
            }

            // Self-evaluation: kalau agent SALAH di trade ini -> dia mengetatkan
            // dirinya sendiri (turunkan keberanian, naikkan ambang aktivasi).
            if !was_correct {
                if rec.performance.win_rate < 45.0 {
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
            } else if rec.performance.win_rate > 60.0 {
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

            let verdict = build_verdict(agent, agreed, is_win, was_correct, &rec.performance);
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
                accuracy: rec.performance.win_rate / 100.0,
                recent_accuracy: rec.performance.win_rate / 100.0,
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

        Self::persist(&state, &self.db_client);
        emitted
    }

    fn persist(state: &EvolutionState, db: &DbClient) {
        if let Ok(json) = serde_json::to_string(state) {
            // [Fase 4] Simpan Permanen di SQLite
            db.save_evolution_state(&json);
        }
        
        // Simpan peta bobot ke DB agent_weights.db (ditambahkan nanti di db_client)
        let weights: HashMap<String, f64> = state
            .agents
            .iter()
            .map(|(k, v)| (k.clone(), v.tunables.weight))
            .collect();
        if let Ok(weights_json) = serde_json::to_string(&weights) {
            db.save_agent_weights(&weights_json);
        }
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
        Direction::Veto => "WAIT".to_string(),
    }
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
    perf: &AgentPerformance,
) -> String {
    let outcome = if is_win { "WIN" } else { "LOSS" };
    let role = match (agreed, is_win) {
        (true, true) => "ikut trade yang menang",
        (true, false) => "ikut trade yang kalah (nyumbang loss)",
        (false, true) => "nolak trade yang ternyata menang (ketinggalan)",
        (false, false) => "nolak trade yang kalah (bantu nyelametin)",
    };
    format!(
        "Trade {outcome}: {agent} {role}. Self-eval -> {}. win_rate={:.0}% loss_streak={}",
        if was_correct {
            "perkuat sinyal"
        } else {
            "ketatkan threshold"
        },
        perf.win_rate,
        perf.loss_streak
    )
}
