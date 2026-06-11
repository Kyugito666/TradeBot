use tiny_http::{Server, Response, Method};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use rayon::prelude::*;
use log::{info, error};

use crate::shm::{MarketSnapshot, Candle};
use crate::agents::Agent;
use crate::db::DbClient;
use crate::storage::parquet_writer::ParquetDB;

#[derive(Deserialize)]
struct ApiRequest {
    symbol: String,
    candles: Vec<Candle>,
    price: f64,
    oi: f64,
    lsr: f64,
}

#[derive(Serialize)]
struct ApiResponse {
    symbol: String,
    signal: String, // "BUY", "SELL", "WAIT"
    confidence: f64,
    veto: bool,
    veto_reason: String,
    entry: f64,
    take_profit: f64,
    stop_loss: f64,
    risk_reward: f64,
}

#[allow(non_snake_case)]
#[derive(Serialize)]
struct ClosedTrade {
    symbol: String,
    side: String,
    entry: f64,
    exit: f64,
    leverage: f64,
    pnlPct: f64,
    pnlR: f64,
    outcome: String,
    entryBar: usize,
    exitBar: usize,
}

pub fn run_server(
    port: u16,
    agents: Arc<Vec<Arc<dyn Agent + Send + Sync>>>,
    db: Arc<DbClient>,
    live_tab: Arc<crate::rooms::TabEnvironment>,
    parquet_db: Arc<ParquetDB>,
) {
    let server = Server::http(format!("0.0.0.0:{}", port)).unwrap();
    info!("🚀 [API] Rust Brain API berjalan di http://0.0.0.0:{}", port);

    for mut request in server.incoming_requests() {
        let is_get = request.method() == &Method::Get;
        let is_post = request.method() == &Method::Post;
        
        if !is_get && !is_post {
            let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
            continue;
        }

        let url = request.url().to_string();
        let mut content = String::new();
        if let Err(_) = request.as_reader().read_to_string(&mut content) {
            let _ = request.respond(Response::from_string("Bad Request").with_status_code(400));
            continue;
        }

        if url == "/api/save_trade" && request.method() == &Method::Post {
            handle_save_trade(content, request, &db);
        } else if url == "/api/evaluate" {
            handle_evaluate(content, request, &agents, &db);
        } else if url == "/api/backtest" {
            handle_backtest(content, request, &agents, &db);
        } else if url == "/api/positions" {
            handle_positions(request, &live_tab);
        } else if url == "/api/mode" {
            handle_mode(content, request, &live_tab);
        } else if url == "/api/performance" {
            handle_performance(request, &db);
        } else if url == "/api/risk" {
            handle_risk(request, &db);
        } else if url == "/api/state" {
            let json = db.load_evolution_state().unwrap_or_else(|| "{}".to_string());
            let mut response = Response::from_string(json);
            response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
            let _ = request.respond(response);
        } else if url == "/api/top_pairs" && request.method() == &Method::Get {
            let pairs = db.get_top_pairs().unwrap_or_else(|_| vec![]);
            let res_json = serde_json::to_string(&pairs).unwrap_or_else(|_| "[]".to_string());
            let mut response = Response::from_string(res_json);
            response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
            let _ = request.respond(response);
        } else if url == "/api/save_backtest" && request.method() == &Method::Post {
            handle_save_backtest(content, request, &db);
        } else if url == "/api/bigdata/stats" && is_get {
            handle_bigdata_stats(request, &parquet_db);
        } else if url == "/api/shadow-trades" && is_get {
            handle_shadow_trades(request, &db);
        } else {
            let _ = request.respond(Response::from_string("Not Found").with_status_code(404));
        }
    }
}

fn handle_evaluate(
    content: String,
    request: tiny_http::Request,
    agents: &Arc<Vec<Arc<dyn Agent + Send + Sync>>>,
    db: &Arc<DbClient>,
) {
    let tab_signal = crate::rooms::TabEnvironment::new("Signal_API", agents.iter().map(|a| a.clone()).collect(), db.clone());

        // Parse array of ApiRequest
        let reqs: Vec<ApiRequest> = match serde_json::from_str(&content) {
            Ok(r) => r,
            Err(e) => {
                error!("API Parse Error: {}", e);
                let _ = request.respond(Response::from_string("JSON Error").with_status_code(400));
                return;
            }
        };
        // Memproses tiap market secara paralel dengan Rayon 
        let results: Vec<ApiResponse> = reqs.into_par_iter().map(|req| {
            let mut symbol_arr = [0u8; crate::shm::SYM_LEN];
            let sym_bytes = req.symbol.as_bytes();
            let len = sym_bytes.len().min(crate::shm::SYM_LEN);
            symbol_arr[..len].copy_from_slice(&sym_bytes[..len]);

            let snap = MarketSnapshot {
                symbol: symbol_arr,
                candles: req.candles,
                price: req.price,
                bid: req.price,
                ask: req.price,
                oi: req.oi,
                lsr: req.lsr,
                atr_14: 0.0, // calculated internally if needed or pass from UI
                funding_rate: 0.0,
                usdt_delta_pct: 0.0,
                kimchi_pct: 0.0,
                whale_inflow_usd: 0.0,
                long_liq_1h: 0.0,
                short_liq_1h: 0.0,
                sentiment_score: 0.0,
                news_count: 0,
                ts_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64,
                raw_ticks: vec![],
            };

            let signal = tab_signal.process_tick(&snap);

            ApiResponse {
                symbol: req.symbol,
                signal: format!("{:?}", signal.action),
                confidence: signal.confidence,
                veto: signal.veto,
                veto_reason: signal.veto_reason.clone(),
                entry: signal.entry,
                take_profit: signal.take_profit,
                stop_loss: signal.stop_loss,
                risk_reward: signal.risk_reward,
            }
        }).collect();

        let res_json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
        let _ = request.respond(Response::from_string(res_json).with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()
        ));
}

#[derive(Deserialize)]
struct BinBacktestRequest {
    symbol: String,
    bin_path: String,
    leverage: f64,
}

fn handle_backtest(
    content: String,
    request: tiny_http::Request,
    agents: &Arc<Vec<Arc<dyn Agent + Send + Sync>>>,
    db: &Arc<DbClient>,
) {
    let tab_backtest = crate::rooms::TabEnvironment::new("Backtest", agents.iter().map(|a| a.clone()).collect(), db.clone());
    let reqs: Vec<BinBacktestRequest> = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(e) => {
            error!("API Parse Error: {}", e);
            let _ = request.respond(Response::from_string("JSON Error").with_status_code(400));
            return;
        }
    };

    let results: Vec<Vec<ClosedTrade>> = reqs.into_par_iter().map(|req| {
        let mut trades = Vec::new();
        
        let mut file = match std::fs::File::open(&req.bin_path) {
            Ok(f) => f,
            Err(_) => return vec![], // File not found or error
        };
        
        use std::io::Read;
        let mut len_buf = [0u8; 4];
        if file.read_exact(&mut len_buf).is_err() { return vec![]; }
        let len = i32::from_le_bytes(len_buf) as usize;
        
        if len < 40 { return vec![]; }
        
        let mut candles = Vec::with_capacity(len);
        let mut row_buf = [0u8; 40];
        
        for i in 0..len {
            if file.read_exact(&mut row_buf).is_err() { break; }
            let open = f64::from_le_bytes(row_buf[0..8].try_into().unwrap());
            let high = f64::from_le_bytes(row_buf[8..16].try_into().unwrap());
            let low = f64::from_le_bytes(row_buf[16..24].try_into().unwrap());
            let close = f64::from_le_bytes(row_buf[24..32].try_into().unwrap());
            let volume = f64::from_le_bytes(row_buf[32..40].try_into().unwrap());
            
            candles.push(crate::shm::Candle {
                open, high, low, close, vol: volume, ts_ms: i as i64 // Placeholder timestamp for now
            });
        }
        
        let n = candles.len();
        if n < 40 { return vec![]; }

        let mut i = 40;
        while i < n - 1 {
            let slice = &candles[0..=i];
            let mut symbol_arr = [0u8; crate::shm::SYM_LEN];
            let sym_bytes = req.symbol.as_bytes();
            let sym_len = sym_bytes.len().min(crate::shm::SYM_LEN);
            symbol_arr[..sym_len].copy_from_slice(&sym_bytes[..sym_len]);

            let snap = MarketSnapshot {
                symbol: symbol_arr,
                candles: slice.to_vec(),
                price: slice.last().unwrap().close,
                bid: slice.last().unwrap().close,
                ask: slice.last().unwrap().close,
                oi: 0.0, lsr: 1.0, atr_14: 0.0, funding_rate: 0.0,
                usdt_delta_pct: 0.0, kimchi_pct: 0.0, whale_inflow_usd: 0.0,
                long_liq_1h: 0.0, short_liq_1h: 0.0, sentiment_score: 0.0, news_count: 0,
                ts_ms: slice.last().unwrap().ts_ms,
                raw_ticks: vec![],
            };

            let signal = tab_backtest.process_tick(&snap);

            if !signal.veto && (matches!(signal.action, crate::shm::Direction::Buy | crate::shm::Direction::Sell)) {
                let entry = signal.entry;
                let tp = signal.take_profit;
                let sl = signal.stop_loss;
                let side = match signal.action {
                    crate::shm::Direction::Buy => "LONG",
                    crate::shm::Direction::Sell => "SHORT",
                    _ => "WAIT",
                };

                let mut outcome = "";
                let mut exit_bar = i;
                for j in (i + 1)..n {
                    let c = &candles[j];
                    if side == "LONG" {
                        if c.low <= sl { outcome = "SL"; exit_bar = j; break; }
                        if c.high >= tp { outcome = "TP"; exit_bar = j; break; }
                    } else {
                        if c.high >= sl { outcome = "SL"; exit_bar = j; break; }
                        if c.low <= tp { outcome = "TP"; exit_bar = j; break; }
                    }
                }
                
                if !outcome.is_empty() {
                    let exit = if outcome == "TP" { tp } else { sl };
                    let dir = if side == "LONG" { 1.0 } else { -1.0 };
                    let price_move_pct = ((exit - entry) / entry) * dir;
                    let pnl_r = if outcome == "TP" { signal.risk_reward } else { -1.0 };
                    
                    trades.push(ClosedTrade {
                        symbol: req.symbol.clone(),
                        side: side.to_string(),
                        entry,
                        exit,
                        leverage: req.leverage,
                        pnlPct: price_move_pct * req.leverage * 100.0,
                        pnlR: pnl_r,
                        outcome: outcome.to_string(),
                        entryBar: i,
                        exitBar: exit_bar,
                    });
                    
                    i = exit_bar; 
                } else {
                    i += 1;
                }
            } else {
                i += 1;
            }
        }
        
        trades
    }).collect();

    let res_json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    let _ = request.respond(Response::from_string(res_json).with_header(
        tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap()
    ));
}

#[allow(non_snake_case)]
#[derive(Deserialize)]
struct PairStatPayload {
    symbol: String,
    trades: i32,
    winRate: f64,
    netPnlPct: f64,
    profitFactor: f64,
}

#[allow(non_snake_case)]
#[derive(Deserialize)]
struct SaveBacktestPayload {
    timestamp: i64,
    cex: String,
    timeframe: String,
    periodDays: i32,
    profitFactor: f64,
    netPnlPct: f64,
    trades: i32,
    winRate: f64,
    scannedPairs: i32,
    pairStats: Option<Vec<PairStatPayload>>,
}

fn handle_save_backtest(
    content: String,
    request: tiny_http::Request,
    db: &Arc<DbClient>,
) {
    let req: SaveBacktestPayload = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(e) => {
            error!("API Parse Error SaveBacktest: {}", e);
            let _ = request.respond(Response::from_string("JSON Error").with_status_code(400));
            return;
        }
    };

    db.save_backtest(
        req.timestamp, &req.cex, &req.timeframe, req.periodDays,
        req.profitFactor, req.netPnlPct, req.trades, req.winRate, req.scannedPairs
    );

    if let Some(stats) = req.pairStats {
        for ps in stats {
            db.save_backtest_pair(
                req.timestamp, &ps.symbol, ps.trades, ps.winRate, ps.netPnlPct, ps.profitFactor
            );
        }
    }

    let mut response = Response::from_string("{\"ok\":true}");
    response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}

fn handle_positions(request: tiny_http::Request, live_tab: &Arc<crate::rooms::TabEnvironment>) {
    let shadows_map = live_tab.get_positions();
    
    let mut shadows_json = Vec::new();
    for (sym, shadows) in shadows_map {
        for s in shadows {
            shadows_json.push(serde_json::json!({
                "symbol": sym,
                "db_id": s.db_id,
                "entry_price": s.entry_price,
                "tp": s.tp,
                "sl": s.sl,
                "direction": format!("{:?}", s.direction),
                "status": s.status,
                "votes": s.agent_votes.iter().map(|(n, d, c)| serde_json::json!({
                    "agent": n, "direction": format!("{:?}", d), "conviction": c
                })).collect::<Vec<_>>()
            }));
        }
    }

    let res = serde_json::json!({
        "active_trades": [], // Kept for backwards compatibility if needed
        "shadow_trades": shadows_json,
        "is_real_money": live_tab.is_real_money.load(std::sync::atomic::Ordering::SeqCst)
    });

    let mut response = Response::from_string(res.to_string());
    response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}

fn handle_mode(content: String, request: tiny_http::Request, live_tab: &Arc<crate::rooms::TabEnvironment>) {
    #[derive(Deserialize)]
    struct ModeReq { mode: String, style: Option<String> }
    
    if let Ok(req) = serde_json::from_str::<ModeReq>(&content) {
        let is_real = req.mode.to_lowercase() == "real";
        live_tab.is_real_money.store(is_real, std::sync::atomic::Ordering::SeqCst);

        // Save style to bot_runtime.conf so it persists!
        if let Some(style) = req.style {
            let conf_path = std::path::Path::new("D:\\database\\config\\bot_runtime.conf");
            let conf_str = format!("TRADING_STYLE=\"{}\"\n", style);
            if let Some(parent) = conf_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(conf_path, conf_str);
            // Also write to WSL local fallback just in case
            let _ = std::fs::write("bot_runtime.conf", format!("TRADING_STYLE=\"{}\"\n", style));
        }

        let mut response = Response::from_string(serde_json::json!({"status": "success", "is_real_money": is_real}).to_string());
        response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
        let _ = request.respond(response);
    } else {
        let _ = request.respond(Response::from_string("JSON Error").with_status_code(400));
    }
}

fn handle_performance(request: tiny_http::Request, db: &Arc<DbClient>) {
    // Check if ?mode=real query param is passed, default to false (paper)
    let is_real = request.url().contains("mode=real");
    let trades = db.read_trade_records(is_real);
    let total_trades = trades.len();
    let wins = trades.iter().filter(|t| t.is_win).count();
    let win_rate = if total_trades > 0 { (wins as f64 / total_trades as f64) * 100.0 } else { 0.0 };
    
    let mut total_profit = 0.0;
    let mut total_loss = 0.0;
    let mut net_pnl = 0.0;
    
    for t in &trades {
        let pnl = if t.is_win { t.rr } else { -1.0 };
        net_pnl += pnl;
        if pnl > 0.0 { total_profit += pnl; } else { total_loss += pnl.abs(); }
    }
    
    let profit_factor = if total_loss > 0.0 { total_profit / total_loss } else { 0.0 };
    
    let res = serde_json::json!({
        "total_trades": total_trades,
        "win_rate": win_rate,
        "net_pnl_r": net_pnl,
        "profit_factor": profit_factor,
        "recent_trades": trades.into_iter().rev().take(10).collect::<Vec<_>>()
    });
    
    let mut response = Response::from_string(res.to_string());
    response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}

fn handle_risk(request: tiny_http::Request, db: &Arc<DbClient>) {
    let is_real = request.url().contains("mode=real");
    let trades = db.read_trade_records(is_real);
    let mut peak_pnl = 0.0;
    let mut current_pnl = 0.0;
    let mut max_drawdown = 0.0;
    let mut consecutive_losses = 0;
    let mut max_consecutive_losses = 0;
    
    for t in &trades {
        let pnl = if t.is_win { t.rr } else { -1.0 };
        current_pnl += pnl;
        
        if current_pnl > peak_pnl {
            peak_pnl = current_pnl;
        }
        
        let drawdown = peak_pnl - current_pnl;
        if drawdown > max_drawdown {
            max_drawdown = drawdown;
        }
        
        if !t.is_win {
            consecutive_losses += 1;
            if consecutive_losses > max_consecutive_losses {
                max_consecutive_losses = consecutive_losses;
            }
        } else {
            consecutive_losses = 0;
        }
    }
    
    let res = serde_json::json!({
        "max_drawdown_r": max_drawdown,
        "max_consecutive_losses": max_consecutive_losses,
        "current_drawdown_r": peak_pnl - current_pnl,
    });
    
    let mut response = Response::from_string(res.to_string());
    response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}

#[allow(non_snake_case)]
#[derive(Deserialize)]
struct SaveTradePayload {
    open_ts: i64,
    close_ts: i64,
    symbol: String,
    direction: String,
    entry: f64,
    tp: f64,
    sl: f64,
    close_price: f64,
    is_win: bool,
    rr: f64,
    is_real_money: bool,
    is_shadow: bool,
}

fn handle_save_trade(content: String, request: tiny_http::Request, db: &Arc<DbClient>) {
    let req: SaveTradePayload = match serde_json::from_str(&content) {
        Ok(r) => r,
        Err(e) => {
            error!("API Parse Error SaveTrade: {}", e);
            let _ = request.respond(Response::from_string("JSON Error").with_status_code(400));
            return;
        }
    };

    db.insert_trade_result(
        req.open_ts, req.close_ts, &req.symbol, &req.direction, req.entry, req.tp, req.sl,
        req.close_price, req.is_win, req.rr, req.is_real_money, req.is_shadow
    );

    let mut response = Response::from_string("{\"ok\":true}");
    response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}

fn handle_bigdata_stats(request: tiny_http::Request, parquet_db: &Arc<ParquetDB>) {
    let buffer_stats = parquet_db.buffer_stats();
    let total_ticks = parquet_db.total_ticks_written();
    let ticks_path = parquet_db.ticks_path();

    // List parquet files in ticks directory with sizes
    let mut files: Vec<serde_json::Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(ticks_path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".parquet") {
                    files.push(serde_json::json!({
                        "name": name,
                        "size_bytes": meta.len(),
                        "size_mb": format!("{:.2}", meta.len() as f64 / 1_048_576.0),
                    }));
                }
            }
        }
    }

    let buffer_json: std::collections::HashMap<String, serde_json::Value> = buffer_stats
        .into_iter()
        .map(|(k, v)| (k, serde_json::json!(v)))
        .collect();

    let total_file_size: u64 = files.iter()
        .filter_map(|f| f.get("size_bytes").and_then(|v| v.as_u64()))
        .sum();

    let res = serde_json::json!({
        "total_ticks_written": total_ticks,
        "buffer_pending": buffer_json,
        "parquet_files": files,
        "total_files": files.len(),
        "total_storage_mb": format!("{:.2}", total_file_size as f64 / 1_048_576.0),
        "ticks_path": ticks_path,
    });

    let mut response = Response::from_string(res.to_string());
    response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}

fn handle_shadow_trades(
    request: tiny_http::Request,
    db: &Arc<DbClient>,
) {
    // Read closed shadow trades from shadow_records.bin
    let closed_records = db.read_shadow_records();
    let pending = db.get_pending_shadow_trades();

    let mut trades = Vec::new();

    // Add open/pending shadow trades
    for (id, sym, dir, entry, tp, sl) in &pending {
        trades.push(serde_json::json!({
            "id": id,
            "symbol": sym,
            "direction": dir,
            "entry": entry,
            "tp": tp,
            "sl": sl,
            "open_ts": 0,
            "veto_reason": "",
            "status": "open",
        }));
    }

    // Add closed shadow trades
    for rec in &closed_records {
        trades.push(serde_json::json!({
            "id": rec.open_ts,
            "symbol": rec.symbol,
            "direction": rec.direction,
            "entry": rec.entry,
            "tp": rec.tp,
            "sl": rec.sl,
            "open_ts": rec.open_ts,
            "close_ts": rec.close_ts,
            "close_price": rec.close_price,
            "is_win": rec.is_win,
            "veto_reason": "",
            "status": "closed",
        }));
    }

    let res = serde_json::json!({
        "trades": trades,
        "total": trades.len(),
    });

    let mut response = Response::from_string(res.to_string());
    response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}
