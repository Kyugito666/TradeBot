import re

with open("rust-brain/src/evolution/mod.rs", "r") as f:
    code = f.read()

imports = """use crate::agents::Direction;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;
use rusqlite::Connection;
use std::sync::mpsc;
use std::thread;"""

code = re.sub(
    r"use crate::agents::Direction;.*?use std::sync::Mutex;",
    imports,
    code,
    flags=re.DOTALL
)

code = code.replace(
    "pub struct EvolutionEngine {\n    state: Mutex<EvolutionState>,\n}",
    "pub struct EvolutionEngine {\n    state: Mutex<EvolutionState>,\n    tx: mpsc::Sender<EvolutionState>,\n}"
)

new_methods = """
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
"""

code = re.sub(
    r"pub fn new.*?fn load_legacy_weights\(\) -> HashMap<String, f64> \{",
    new_methods,
    code,
    flags=re.DOTALL
)

code = re.sub(
    r"fn load_state\(\) -> Option<EvolutionState> \{.*?\}",
    "",
    code,
    flags=re.DOTALL
)

persist_update = """
        Self::persist(&state, &self.tx);
        emitted
    }

    fn persist(state: &EvolutionState, tx: &mpsc::Sender<EvolutionState>) {
        let _ = tx.send(state.clone());
    }
}
"""

code = re.sub(
    r"Self::persist\(&state\);\n        emitted\n    \}\n\n    fn persist\(state: &EvolutionState\) \{.*?\n    \}\n\}",
    persist_update,
    code,
    flags=re.DOTALL
)

with open("rust-brain/src/evolution/mod.rs", "w") as f:
    f.write(code)
