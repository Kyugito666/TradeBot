// rust-brain/src/main.rs  (PRODUCTION-CORRECTED)
//
// Module declarations:
//   mod shm     → src/shm.rs          (POSIX SHM bridge)
//   mod agents  → src/agents/mod.rs   (6 agent implementations)
//   mod consensus → src/consensus/mod.rs

use std::time::{Duration, Instant};
use log::{error, info, warn};
use std::thread;

mod agents;
mod consensus;
mod evolution;
mod shm;
mod db;
mod api;
mod rooms;
mod storage;
mod backtest;
mod quant;

use db::DbClient;
use std::sync::Arc;

use agents::{
    absurdist::AbsurdistAgent,
    cryptographer::CryptographerAgent,
    data_engineer::DataEngineer,
    economist::Economist,
    game_theorist::GameTheorist,
    linguist::LinguistAgent,
    liquidator::LiquidatorAgent,
    mathematician::MathematicianAgent,
    physicist::PhysicistAgent,
    data_scientist::DataScientist,
    statistician::Statistician,
    psychologist::Psychologist,
    astrophysicist::Astrophysicist,
    Agent,
};
use shm::ShmBridge;

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .format_timestamp_millis()
    .init();

    info!("═══════════════════════════════════════════════════════");
    info!("  TradeBot Brain v4.0 — 13-Agent Ensemble  (rayon)");
    info!("  Agents: Mathematician · Physicist · Cryptographer");
    info!("          Linguist · Liquidator · Absurdist ✦");
    info!("          Data Scientist · Statistician · Psychologist · Astrophysicist");
    info!("═══════════════════════════════════════════════════════");

    rayon::ThreadPoolBuilder::new()
        .num_threads(13)
        .thread_name(|i| format!("agent-{i}"))
        .build_global()
        .expect("rayon pool init");

fn create_all_agents() -> Vec<Arc<dyn Agent + Send + Sync>> {
    vec![
        Arc::new(DataEngineer),
        Arc::new(Economist),
        Arc::new(GameTheorist),
        Arc::new(MathematicianAgent::default()),
        Arc::new(PhysicistAgent::default()),
        Arc::new(CryptographerAgent),
        Arc::new(LinguistAgent),
        Arc::new(LiquidatorAgent),
        Arc::new(AbsurdistAgent),
        Arc::new(DataScientist),
        Arc::new(Statistician),
        Arc::new(Psychologist),
        Arc::new(Astrophysicist),
    ]
}

    let db_dir = std::env::var("BOT_DB_DIR").unwrap_or_else(|_| "/mnt/d/database".to_string());
    let db_client = Arc::new(DbClient::new(&db_dir).expect("Gagal inisialisasi SQLite"));
    let parquet_db = Arc::new(storage::parquet_writer::ParquetDB::new(&db_dir));

    let live_agents = create_all_agents();
    let api_agents = create_all_agents();

    let arc_live_agents = Arc::new(live_agents);
    let arc_api_agents = Arc::new(api_agents);

    let api_db = db_client.clone();
    
    // Tab Signal Live (The real background engine evaluating shadow trades)
    let tab_signal = Arc::new(rooms::TabEnvironment::new("Signal_Live", arc_live_agents.iter().map(|a| a.clone()).collect(), db_client.clone()));
    let api_live_tab = tab_signal.clone();
    
    let thread_live_tab = api_live_tab.clone();

    let api_parquet_db = parquet_db.clone();
    thread::spawn(move || {
        api::run_server(8080, arc_api_agents, api_db, thread_live_tab, api_parquet_db);
    });

    // Wait for Go engine to create SHM
    let mut bridge = {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match ShmBridge::open() {
                Ok(b)  => { info!("[SHM] Connected"); break b; }
                Err(e) => {
                    if Instant::now() > deadline {
                        error!("[SHM] Waduh timeout nungguin Go engine. Udah jalan belom tuh?");
                        return Err(e);
                    }
                    warn!("[SHM] Belom ready: {e}. Sabar, nyoba lagi dalam 1 detik…");
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    };

    info!("[Otak-AI] Udah ready nih bos! Tinggal nunggu data dari market…");

    // [New Architecture] 13 Agent Bunshin into 4 Rooms!
    // Initialize Tab Signal once outside the loop to maintain HFT Zero-Latency!
    // (Already done above, passing api_live_tab instead)
    let tab_signal = api_live_tab.clone();

    // ── BigData: Periodic tick buffer flush (every 30 seconds) ────────────
    {
        let pq = parquet_db.clone();
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(30));
                pq.flush_all();
            }
        });
        info!("[BigData] Periodic tick flush thread started (every 30s)");
    }

    let mut last_ts: i64 = 0;
    let mut iteration: u64 = 0;

    loop {
        let snap = match bridge.wait_for_market(Duration::from_secs(60)) {
            Some(s) => s,
            None => {
                warn!("[Otak-AI] Udah 60 detik gada data market sama sekali nih. Go engine nya idup ga tuh?");
                continue;
            }
        };

        if snap.ts_ms == last_ts {
            std::hint::spin_loop();
            continue;
        }
        last_ts = snap.ts_ms;
        iteration += 1;

        let sym = std::str::from_utf8(&snap.symbol)
            .unwrap_or("???")
            .trim_end_matches('\0');

        // Implement continuous Raw Tick appending to Parquet
        if !snap.raw_ticks.is_empty() {
            let mut timestamps = Vec::with_capacity(snap.raw_ticks.len());
            let mut prices = Vec::with_capacity(snap.raw_ticks.len());
            let mut volumes = Vec::with_capacity(snap.raw_ticks.len());
            for t in &snap.raw_ticks {
                timestamps.push(t.ts_ms);
                prices.push(t.price);
                volumes.push(t.size);
            }
            if let Err(e) = parquet_db.write_unfiltered_ticks(sym, timestamps, prices, volumes) {
                error!("[Parquet] Failed to append raw ticks for {}: {}", sym, e);
            }
        }

        let _t_start = Instant::now();

        // Process tick through the 4 Rooms (Diskusi, Eksekusi, Storage, Courier)
        // TabEnvironment implicitly runs Consensus Engine inside Room Eksekusi and returns SignalOutput!
        let signal = tab_signal.process_tick(&snap);

        let elapsed_us = _t_start.elapsed().as_micros();

        // 5. Send command to Gateway
        let _resp_arr = [0u8; 1024];

        info!(
            "[Otak-AI] #{iteration} {sym} harga={:.4} │ Analisa: {:?} yakin={:.3} RR={:.2} │ Waktu Mikir: {elapsed_us}µs",
            snap.price, signal.action, signal.confidence, signal.risk_reward
        );

        if signal.veto {
            if signal.veto_reason.contains("buntu") {
                info!("[Otak-AI] ⏳ Nunggu Momen: {}", signal.veto_reason);
            } else {
                warn!("[Otak-AI] 🚫 GAGAL ENTRY: {}", signal.veto_reason);
            }
        } else if matches!(signal.action, agents::Direction::Buy | agents::Direction::Sell) {
            info!(
                "[Otak-AI] ★ GAS TEROOOS! Mau {:?} di harga {:.4} | TP di {:.4} | SL di {:.4} | Tingkat Yakin: {:.3}",
                signal.action, signal.entry, signal.take_profit, signal.stop_loss, signal.confidence
            );
        }

        bridge.write_signal(&signal);
    }
}
