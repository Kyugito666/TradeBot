use std::sync::mpsc::{channel, Sender};
use std::thread;
use log::info;
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use crate::agents::AgentVote;
use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize)]
pub struct TradeRecord {
    pub open_ts: i64,
    pub close_ts: i64,
    pub symbol: String,
    pub direction: String,
    pub entry: f64,
    pub tp: f64,
    pub sl: f64,
    pub close_price: f64,
    pub is_win: bool,
    pub rr: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct BacktestRecord {
    pub ts: i64,
    pub cex: String,
    pub timeframe: String,
    pub period_days: i32,
    pub profit_factor: f64,
    pub net_pnl: f64,
    pub trades: i32,
    pub win_rate: f64,
    pub scanned: i32,
}

#[allow(dead_code)]
pub enum DbMsg {
    AgentVote { ts_ms: i64, symbol: String, agent_name: String, direction: String, conviction: f64, reasoning: String, is_clean: bool },
    TradeResult { open_ts: i64, close_ts: i64, symbol: String, direction: String, entry: f64, tp: f64, sl: f64, close_price: f64, is_win: bool, rr: f64, is_real_money: bool, is_shadow: bool },
    InsertShadowTrade { id: i64, open_ts: i64, symbol: String, direction: String, entry: f64, tp: f64, sl: f64, veto_reason: String, is_real_money: bool },
    UpdateShadowTrade { id: i64, close_ts: i64, close_price: f64, is_win: bool },
    InsertConsensusSignal { ts_ms: i64, symbol: String, final_dir: String, confidence: f64, veto_reason: String },
    SaveEvolutionState { json: String },
    SaveAgentWeights { json: String },
    SaveBacktest { ts: i64, cex: String, timeframe: String, period_days: i32, profit_factor: f64, net_pnl: f64, trades: i32, win_rate: f64, scanned: i32 },
    SaveBacktestPair { backtest_ts: i64, symbol: String, trades: i32, win_rate: f64, net_pnl: f64, profit_factor: f64 },
}

#[allow(dead_code)]
pub struct DbClient {
    tx: Sender<DbMsg>,
    pub engine_dir: String,
    pub brain_dir: String,
}

#[allow(dead_code)]
impl DbClient {
    pub fn new(env_db_path: &str) -> anyhow::Result<Self> {
        let (tx, rx) = channel::<DbMsg>();

        let mut base_dir = PathBuf::from(env_db_path);
        if env_db_path.ends_with(".db") {
            base_dir.pop();
        }

        let brain_dir = base_dir.join("brain");
        let engine_dir = base_dir.join("engine");
        
        let brain_dir_str = brain_dir.to_str().unwrap().to_string();
        let engine_dir_str = engine_dir.to_str().unwrap().to_string();

        create_dir_all(&brain_dir_str).unwrap_or_else(|_| ());
        create_dir_all(&engine_dir_str).unwrap_or_else(|_| ());

        // let logs_bin = format!("{}/agent_logs.bin", brain_dir_str);
        let evolution_bin = format!("{}/evolution_state.bin", brain_dir_str);
        
        let trades_bin = format!("{}/trade_records.bin", engine_dir_str);
        let paper_trades_bin = format!("{}/paper_records.bin", engine_dir_str);
        let shadow_trades_bin = format!("{}/shadow_records.bin", engine_dir_str);
        let backtest_bin = format!("{}/backtest_records.bin", engine_dir_str);

        // Pre-create the files so the user doesn't see an empty directory
        let _ = OpenOptions::new().create(true).append(true).open(&trades_bin);
        let _ = OpenOptions::new().create(true).append(true).open(&paper_trades_bin);
        let _ = OpenOptions::new().create(true).append(true).open(&shadow_trades_bin);
        let _ = OpenOptions::new().create(true).append(true).open(&backtest_bin);

        let thread_engine_dir_str = engine_dir_str.clone();

        thread::spawn(move || {
            for msg in rx {
                match msg {
                    DbMsg::AgentVote { .. } => {
                        // DISABLE agent_logs.bin write because it floods 1GB of data in minutes and blocks the channel!
                        // if !is_clean { continue; }
                        // if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&logs_bin) {
                        //     let mut buf = Vec::new();
                        //     buf.extend_from_slice(&ts_ms.to_be_bytes());
                        //     // ...
                        //     let _ = file.write_all(&buf);
                        // }
                    }
                    DbMsg::TradeResult { open_ts, close_ts, symbol, direction, entry, tp, sl, close_price, is_win, rr, is_real_money, is_shadow } => {
                        let target_bin = if is_shadow {
                            &shadow_trades_bin
                        } else if is_real_money { 
                            &trades_bin 
                        } else { 
                            &paper_trades_bin 
                        };
                        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(target_bin) {
                            let mut buf = Vec::new();
                            buf.extend_from_slice(&open_ts.to_be_bytes());
                            buf.extend_from_slice(&close_ts.to_be_bytes());
                            buf.push(symbol.len() as u8);
                            buf.extend_from_slice(symbol.as_bytes());
                            buf.push(direction.len() as u8);
                            buf.extend_from_slice(direction.as_bytes());
                            buf.extend_from_slice(&entry.to_be_bytes());
                            buf.extend_from_slice(&tp.to_be_bytes());
                            buf.extend_from_slice(&sl.to_be_bytes());
                            buf.extend_from_slice(&close_price.to_be_bytes());
                            buf.push(if is_win { 1 } else { 0 });
                            buf.extend_from_slice(&rr.to_be_bytes());
                            let _ = file.write_all(&buf);
                        }
                    }
                    DbMsg::SaveEvolutionState { json } => {
                        if let Ok(mut file) = OpenOptions::new().create(true).write(true).truncate(true).open(&evolution_bin) {
                            let _ = file.write_all(json.as_bytes());
                        }
                    }
                    DbMsg::SaveBacktest { ts, cex, timeframe, period_days, profit_factor, net_pnl, trades, win_rate, scanned } => {
                        let backtest_bin = format!("{}/backtest_records.bin", thread_engine_dir_str);
                        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&backtest_bin) {
                            let mut buf = Vec::new();
                            buf.extend_from_slice(&ts.to_be_bytes());
                            buf.push(cex.len() as u8);
                            buf.extend_from_slice(cex.as_bytes());
                            buf.push(timeframe.len() as u8);
                            buf.extend_from_slice(timeframe.as_bytes());
                            buf.extend_from_slice(&period_days.to_be_bytes());
                            buf.extend_from_slice(&profit_factor.to_be_bytes());
                            buf.extend_from_slice(&net_pnl.to_be_bytes());
                            buf.extend_from_slice(&trades.to_be_bytes());
                            buf.extend_from_slice(&win_rate.to_be_bytes());
                            buf.extend_from_slice(&scanned.to_be_bytes());
                            let _ = file.write_all(&buf);
                        }
                    }
                    // Skip other SQLite specific updates for pure binary append mode.
                    _ => {}
                }
            }
        });

        info!("[Database] Binary File DB connected (brain & engine separated)");
        
        Ok(Self {
            tx,
            engine_dir: engine_dir_str,
            brain_dir: brain_dir_str,
        })
    }

    pub fn insert_agent_vote(&self, ts_ms: i64, symbol: &str, agent_name: &str, direction: &str, conviction: f64, reasoning: &str, is_clean: bool) {
        let _ = self.tx.send(DbMsg::AgentVote {
            ts_ms, symbol: symbol.to_string(), agent_name: agent_name.to_string(), direction: direction.to_string(), conviction, reasoning: reasoning.to_string(), is_clean
        });
    }

    pub fn insert_trade_result(&self, open_ts: i64, close_ts: i64, symbol: &str, direction: &str, entry: f64, tp: f64, sl: f64, close_price: f64, is_win: bool, rr: f64, is_real_money: bool, is_shadow: bool) {
        let _ = self.tx.send(DbMsg::TradeResult {
            open_ts, close_ts, symbol: symbol.to_string(), direction: direction.to_string(), entry, tp, sl, close_price, is_win, rr, is_real_money, is_shadow
        });
    }

    pub fn insert_consensus_signal(&self, ts_ms: i64, symbol: &str, final_dir: &str, confidence: f64, veto_reason: &str) {
        let _ = self.tx.send(DbMsg::InsertConsensusSignal {
            ts_ms, symbol: symbol.to_string(), final_dir: final_dir.to_string(), confidence, veto_reason: veto_reason.to_string()
        });
    }

    pub fn insert_shadow_trade(&self, open_ts: i64, symbol: &str, direction: &str, entry: f64, tp: f64, sl: f64, veto_reason: &str, is_real_money: bool) -> i64 {
        let id = chrono::Utc::now().timestamp_micros() * 100 + (open_ts % 100);
        let _ = self.tx.send(DbMsg::InsertShadowTrade {
            id, open_ts, symbol: symbol.to_string(), direction: direction.to_string(), entry, tp, sl, veto_reason: veto_reason.to_string(), is_real_money
        });
        id
    }

    pub fn update_shadow_trade(&self, id: i64, close_ts: i64, close_price: f64, is_win: bool) {
        let _ = self.tx.send(DbMsg::UpdateShadowTrade {
            id, close_ts, close_price, is_win
        });
    }

    pub fn get_agent_votes(&self, _ts_ms: i64) -> Vec<AgentVote> {
        // Mock returning empty for pure append-only DB without index
        Vec::new()
    }

    pub fn save_evolution_state(&self, json: &str) {
        let _ = self.tx.send(DbMsg::SaveEvolutionState { json: json.to_string() });
    }

    pub fn save_agent_weights(&self, json: &str) {
        let _ = self.tx.send(DbMsg::SaveAgentWeights { json: json.to_string() });
    }

    pub fn read_trade_records(&self, read_real_money: bool) -> Vec<TradeRecord> {
        use std::io::Read;
        let mut records = Vec::new();
        let target_bin = if read_real_money { "trade_records.bin" } else { "paper_records.bin" };
        let path = format!("{}/{}", self.engine_dir, target_bin);
        if let Ok(mut file) = std::fs::File::open(&path) {
            let mut buf = Vec::new();
            if file.read_to_end(&mut buf).is_ok() {
                let mut offset = 0;
                while offset + 16 < buf.len() { // at least open_ts and close_ts
                    let mut b8 = [0u8; 8];
                    
                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let open_ts = i64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let close_ts = i64::from_be_bytes(b8);
                    offset += 8;

                    let sym_len = buf[offset] as usize;
                    offset += 1;
                    let symbol = String::from_utf8_lossy(&buf[offset..offset+sym_len]).into_owned();
                    offset += sym_len;

                    let dir_len = buf[offset] as usize;
                    offset += 1;
                    let direction = String::from_utf8_lossy(&buf[offset..offset+dir_len]).into_owned();
                    offset += dir_len;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let entry = f64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let tp = f64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let sl = f64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let close_price = f64::from_be_bytes(b8);
                    offset += 8;

                    let is_win = buf[offset] == 1;
                    offset += 1;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let rr = f64::from_be_bytes(b8);
                    offset += 8;

                    records.push(TradeRecord {
                        open_ts, close_ts, symbol, direction, entry, tp, sl, close_price, is_win, rr
                    });
                }
            }
        }
        records
    }

    pub fn load_evolution_state(&self) -> Option<String> {
        None
    }

    pub fn load_agent_weights(&self) -> Option<String> {
        None
    }

    pub fn get_pending_shadow_trades(&self) -> Vec<(i64, String, String, f64, f64, f64)> {
        Vec::new()
    }

    pub fn save_backtest(&self, ts: i64, cex: &str, timeframe: &str, period_days: i32, profit_factor: f64, net_pnl: f64, trades: i32, win_rate: f64, scanned: i32) {
        let _ = self.tx.send(DbMsg::SaveBacktest {
            ts, cex: cex.to_string(), timeframe: timeframe.to_string(), period_days, profit_factor, net_pnl, trades, win_rate, scanned
        });
    }

    pub fn save_backtest_pair(&self, backtest_ts: i64, symbol: &str, trades: i32, win_rate: f64, net_pnl: f64, profit_factor: f64) {
        let _ = self.tx.send(DbMsg::SaveBacktestPair {
            backtest_ts, symbol: symbol.to_string(), trades, win_rate, net_pnl, profit_factor
        });
    }

    pub fn get_top_pairs(&self) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }

    /// Read shadow trade records (same binary format as trade records)
    pub fn read_shadow_records(&self) -> Vec<TradeRecord> {
        use std::io::Read;
        let mut records = Vec::new();
        let path = format!("{}/shadow_records.bin", self.engine_dir);
        if let Ok(mut file) = std::fs::File::open(&path) {
            let mut buf = Vec::new();
            if file.read_to_end(&mut buf).is_ok() {
                let mut offset = 0;
                while offset + 16 < buf.len() {
                    let mut b8 = [0u8; 8];

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let open_ts = i64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let close_ts = i64::from_be_bytes(b8);
                    offset += 8;

                    if offset >= buf.len() { break; }
                    let sym_len = buf[offset] as usize;
                    offset += 1;
                    if offset + sym_len > buf.len() { break; }
                    let symbol = String::from_utf8_lossy(&buf[offset..offset+sym_len]).into_owned();
                    offset += sym_len;

                    if offset >= buf.len() { break; }
                    let dir_len = buf[offset] as usize;
                    offset += 1;
                    if offset + dir_len > buf.len() { break; }
                    let direction = String::from_utf8_lossy(&buf[offset..offset+dir_len]).into_owned();
                    offset += dir_len;

                    if offset + 33 > buf.len() { break; }

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let entry = f64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let tp = f64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let sl = f64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let close_price = f64::from_be_bytes(b8);
                    offset += 8;

                    let is_win = buf[offset] == 1;
                    offset += 1;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let rr = f64::from_be_bytes(b8);
                    offset += 8;

                    records.push(TradeRecord {
                        open_ts, close_ts, symbol, direction, entry, tp, sl, close_price, is_win, rr
                    });
                }
            }
        }
        records
    }

    /// Read backtest summary records
    pub fn read_backtest_records(&self) -> Vec<BacktestRecord> {
        use std::io::Read;
        let mut records = Vec::new();
        let path = format!("{}/backtest_records.bin", self.engine_dir);
        if let Ok(mut file) = std::fs::File::open(&path) {
            let mut buf = Vec::new();
            if file.read_to_end(&mut buf).is_ok() {
                let mut offset = 0;
                while offset + 8 < buf.len() {
                    let mut b8 = [0u8; 8];
                    let mut b4 = [0u8; 4];

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let ts = i64::from_be_bytes(b8);
                    offset += 8;

                    if offset >= buf.len() { break; }
                    let cex_len = buf[offset] as usize;
                    offset += 1;
                    if offset + cex_len > buf.len() { break; }
                    let cex = String::from_utf8_lossy(&buf[offset..offset+cex_len]).into_owned();
                    offset += cex_len;

                    if offset >= buf.len() { break; }
                    let tf_len = buf[offset] as usize;
                    offset += 1;
                    if offset + tf_len > buf.len() { break; }
                    let timeframe = String::from_utf8_lossy(&buf[offset..offset+tf_len]).into_owned();
                    offset += tf_len;

                    if offset + 36 > buf.len() { break; }

                    b4.copy_from_slice(&buf[offset..offset+4]);
                    let period_days = i32::from_be_bytes(b4);
                    offset += 4;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let profit_factor = f64::from_be_bytes(b8);
                    offset += 8;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let net_pnl = f64::from_be_bytes(b8);
                    offset += 8;

                    b4.copy_from_slice(&buf[offset..offset+4]);
                    let trades = i32::from_be_bytes(b4);
                    offset += 4;

                    b8.copy_from_slice(&buf[offset..offset+8]);
                    let win_rate = f64::from_be_bytes(b8);
                    offset += 8;

                    b4.copy_from_slice(&buf[offset..offset+4]);
                    let scanned = i32::from_be_bytes(b4);
                    offset += 4;

                    records.push(BacktestRecord {
                        ts, cex, timeframe, period_days, profit_factor, net_pnl, trades, win_rate, scanned
                    });
                }
            }
        }
        records
    }
}
