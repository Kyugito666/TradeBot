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
mod shm;

use agents::{
    absurdist::AbsurdistAgent,
    cryptographer::CryptographerAgent,
    linguist::LinguistAgent,
    liquidator::LiquidatorAgent,
    mathematician::MathematicianAgent,
    physicist::PhysicistAgent,
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
    info!("  TradeBot Brain v3.0 — 6-Agent Ensemble  (rayon)");
    info!("  Agents: Mathematician · Physicist · Cryptographer");
    info!("          Linguist · Liquidator · Absurdist ✦");
    info!("═══════════════════════════════════════════════════════");

    rayon::ThreadPoolBuilder::new()
        .num_threads(6)
        .thread_name(|i| format!("agent-{i}"))
        .build_global()
        .expect("rayon pool init");

    let agents: Vec<Box<dyn Agent + Send + Sync>> = vec![
        Box::new(MathematicianAgent::default()),
        Box::new(PhysicistAgent::default()),
        Box::new(CryptographerAgent),
        Box::new(LinguistAgent),
        Box::new(LiquidatorAgent),
        Box::new(AbsurdistAgent),
    ];

    let consensus = ConsensusEngine;

    // Wait for Go engine to create SHM
    let mut bridge = {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match ShmBridge::open() {
                Ok(b)  => { info!("[SHM] Connected"); break b; }
                Err(e) => {
                    if Instant::now() > deadline {
                        error!("[SHM] Timeout waiting for Go engine. Is it running?");
                        return Err(e);
                    }
                    warn!("[SHM] Not ready: {e}. Retrying in 1s…");
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    };

    info!("[Brain] Ready. Waiting for market data…");

    let mut last_ts: i64 = 0;
    let mut iteration: u64 = 0;

    loop {
        let snap = match bridge.wait_for_market(Duration::from_secs(60)) {
            Some(s) => s,
            None => {
                warn!("[Brain] 60s timeout — no market data. Is Go engine alive?");
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
            "[Brain] #{iteration} {sym} price={:.4} │ {:?} conf={:.3} RR={:.2} │ {elapsed_us}µs",
            snap.price, signal.action, signal.confidence, signal.risk_reward
        );

        if signal.veto {
            warn!("[Brain] VETO: {}", signal.veto_reason);
        } else if matches!(signal.action, agents::Direction::Buy | agents::Direction::Sell) {
            info!(
                "[Brain] ★ {:?} entry={:.4} TP={:.4} SL={:.4} conf={:.3}",
                signal.action, signal.entry, signal.take_profit, signal.stop_loss, signal.confidence
            );
        }

        bridge.write_signal(&signal);
    }
}
