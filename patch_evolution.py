import re

with open("rust-brain/src/evolution/mod.rs", "r") as f:
    code = f.read()

# Add const MAX_RECENT_PNL: usize = 50;
code = code.replace("const MAX_RECENT: usize = 20;", "const MAX_RECENT: usize = 20;\nconst MAX_RECENT_PNL: usize = 50;")

# Update AgentScorecard
old_agent_scorecard = """pub struct AgentScorecard {
    pub trades: u64,
    pub correct: u64,
    pub incorrect: u64,
    pub accuracy: f64,
    pub recent_accuracy: f64,
    pub pnl_contrib: f64, // proxy kontribusi R: +rr kalau ikut menang, -1 kalau ikut kalah
    pub wrong_streak: u32,
    #[serde(default)]
    pub recent: Vec<bool>, // true = benar, false = salah (window MAX_RECENT)
}"""
new_agent_scorecard = """pub struct AgentScorecard {
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
}"""
code = code.replace(old_agent_scorecard, new_agent_scorecard)

# Update TeamScorecard
old_team_scorecard = """pub struct TeamScorecard {
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
}"""
new_team_scorecard = """pub struct TeamScorecard {
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
}"""
code = code.replace(old_team_scorecard, new_team_scorecard)

# Helpers for PNL capping
code = code.replace("fn push_capped(v: &mut Vec<bool>, val: bool) {", """fn push_capped_pnl(v: &mut Vec<f64>, val: f64) {
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

fn push_capped(v: &mut Vec<bool>, val: bool) {""")

# Update on_trade_closed Team Logic
code = code.replace(
    "push_capped(&mut state.team.recent_results, is_win);",
    "push_capped(&mut state.team.recent_results, is_win);\n        push_capped_pnl(&mut state.team.recent_pnl, if is_win { rr.max(0.1) } else { -1.0 });\n        state.team.expected_value = calc_ev(&state.team.recent_pnl);"
)

# Replace Agent Logic
old_agent_logic = """            push_capped(&mut rec.scorecard.recent, was_correct);
            rec.scorecard.accuracy = rec.scorecard.correct as f64 / rec.scorecard.trades.max(1) as f64;
            rec.scorecard.recent_accuracy = recent_rate(&rec.scorecard.recent);
            rec.scorecard.pnl_contrib += if agreed {
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
                if rec.scorecard.recent_accuracy < 0.45 {
                    rec.tunables.activation_gate =
                        (rec.tunables.activation_gate + 0.05).min(GATE_MAX);
                    rec.tunables.conviction_scale =
                        (rec.tunables.conviction_scale - 0.05).max(CONV_SCALE_MIN);"""

new_agent_logic = """            push_capped(&mut rec.scorecard.recent, was_correct);
            
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
                        (rec.tunables.conviction_scale - 0.05).max(CONV_SCALE_MIN);"""

code = code.replace(old_agent_logic, new_agent_logic)

# Replace the > 0.60 condition
code = code.replace("} else if rec.scorecard.recent_accuracy > 0.60 {", "} else if rec.scorecard.expected_value > 0.20 {")

# Update build_verdict call
code = code.replace(
    'sc.recent_accuracy * 100.0,\n        sc.wrong_streak',
    'sc.expected_value,\n        sc.wrong_streak'
)
code = code.replace("acc={:.0}% recent={:.0}% wrong_streak={}", "acc={:.0}% EV={:.2}R wrong_streak={}")


# Add Team EV snapshot getter
team_ev_getter = """    pub fn team_expected_value(&self) -> f64 {
        self.state.lock().unwrap().team.expected_value
    }
    
    pub fn team_recent_pnl(&self) -> Vec<f64> {
        self.state.lock().unwrap().team.recent_pnl.clone()
    }"""
    
code = code.replace("pub fn conservatism_bias(&self) -> f64 {", team_ev_getter + "\n\n    pub fn conservatism_bias(&self) -> f64 {")


with open("rust-brain/src/evolution/mod.rs", "w") as f:
    f.write(code)
