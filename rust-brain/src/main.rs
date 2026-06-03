// rust-brain/src/main.rs  (PRODUCTION-CORRECTED)
//
// Module declarations:
//   mod shm     → src/shm.rs          (POSIX SHM bridge)
//   mod agents  → src/agents/mod.rs   (6 agent implementations)
//   mod consensus → src/consensus/mod.rs

use std::time::{Duration, Instant};
use log::{error, info, warn};
use rayon::prelude::*;

mod agents;
mod consensus;
mod evolution;
mod shm;

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
    Agent, AgentVote,
};
use consensus::ConsensusEngine;
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

    let agents: Vec<Box<dyn Agent + Send + Sync>> = vec![
        Box::new(DataEngineer),
        Box::new(Economist),
        Box::new(GameTheorist),
        Box::new(MathematicianAgent::default()),
        Box::new(PhysicistAgent::default()),
        Box::new(CryptographerAgent),
        Box::new(LinguistAgent),
        Box::new(LiquidatorAgent),
        Box::new(AbsurdistAgent),
        Box::new(DataScientist::new()),
        Box::new(Statistician),
        Box::new(Psychologist),
        Box::new(Astrophysicist),
    ];

    let consensus = ConsensusEngine::new();

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

        let t_start = Instant::now();

        let votes: Vec<AgentVote> = agents
            .par_iter()
            .map(|agent| {
                let t = Instant::now();
                let vote = agent.analyze(&snap);
                log::debug!(
                    "[{:>13}] {:?} conv={:.3}  ({:.2}ms)  {}",
                    vote.agent,
                    vote.direction,
                    vote.conviction,
                    t.elapsed().as_secs_f64() * 1000.0,
                    &vote.reasoning[..vote.reasoning.len().min(90)]
                );
                vote
            })
            .collect();

        let signal = consensus.evaluate(&votes, &snap);
        let elapsed_us = t_start.elapsed().as_micros();

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
