// rust-brain/src/main.rs
//
// TradeBot Brain v3.0 — Zero-Latency 6-Agent Ensemble
// =====================================================
// Process lifecycle:
//   1. Connect to POSIX SHM /tradebot_v3 (created by Go engine on startup)
//   2. Block on data_ready flag (seqlock protocol)
//   3. Snapshot MarketData → run 6 agents in parallel via rayon
//   4. ConsensusEngine evaluates all votes → single SignalResult
//   5. Write SignalResult to SHM, set signal_ready=1, wake Go executor
//   6. Goto 2 (sub-millisecond loop)

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
    // Initialise logger from RUST_LOG env var, default = info
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .format_timestamp_millis()
    .init();

    info!("═══════════════════════════════════════════════════════");
    info!("  TradeBot Brain v3.0 — 6-Agent Ensemble  (rayon)");
    info!("═══════════════════════════════════════════════════════");

    // Tune rayon thread pool: 1 thread per agent (6) + 1 consensus = 7 max.
    // Leaving OS scheduler headroom; exchange I/O runs in Go.
    rayon::ThreadPoolBuilder::new()
        .num_threads(6)
        .thread_name(|i| format!("agent-{i}"))
        .build_global()
        .expect("Failed to configure rayon thread pool");

    // Instantiate all 6 agents once — they are stateless pure functions.
    // Boxed behind the Agent trait for uniform dispatch in the par_iter.
    let agents: Vec<Box<dyn Agent + Send + Sync>> = vec![
        Box::new(MathematicianAgent::default()),
        Box::new(PhysicistAgent::default()),
        Box::new(CryptographerAgent),
        Box::new(LinguistAgent),
        Box::new(LiquidatorAgent),
        Box::new(AbsurdistAgent),
    ];

    let consensus = ConsensusEngine;

    // ── Connect to SHM (Go must create it first) ──────────────────────────
    let mut bridge = {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match ShmBridge::open() {
                Ok(b) => {
                    info!("[SHM] Connected to /tradebot_v3");
                    break b;
                }
                Err(e) => {
                    if Instant::now() > deadline {
                        error!("[SHM] Timeout waiting for Go gateway. Aborting.");
                        return Err(e);
                    }
                    warn!("[SHM] Not ready: {e}. Retrying in 1s…");
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        }
    };

    info!("[Brain] Ready. Waiting for market data…");

    let mut iteration: u64 = 0;
    let mut last_ts: i64 = 0;

    loop {
        // ── Block until Go writes fresh MarketData ─────────────────────────
        let snap = match bridge.wait_for_market(Duration::from_secs(60)) {
            Some(s) => s,
            None => {
                warn!("[Brain] 60s timeout — no market data. Is Go engine alive?");
                continue;
            }
        };

        // Skip stale snapshots (Go may write same ts twice on reconnect)
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

        // ── Run all 6 agents concurrently ─────────────────────────────────
        let votes: Vec<AgentVote> = agents
            .par_iter()
            .map(|agent| {
                let t = Instant::now();
                let vote = agent.analyze(&snap);
                log::debug!(
                    "[{:>12}] {:?} conviction={:.3}  ({:.2}ms)  {}",
                    vote.agent,
                    vote.direction,
                    vote.conviction,
                    t.elapsed().as_secs_f64() * 1000.0,
                    &vote.reasoning[..vote.reasoning.len().min(80)]
                );
                vote
            })
            .collect();

        // ── Consensus evaluation ───────────────────────────────────────────
        let signal = consensus.evaluate(&votes, &snap);

        let elapsed_us = t_start.elapsed().as_micros();

        info!(
            "[Brain] iter={iteration} sym={sym} price={:.4} │ {:?} conf={:.3} RR={:.2} │ {elapsed_us}µs",
            snap.price, signal.action, signal.confidence, signal.risk_reward
        );

        if signal.veto {
            warn!("[Brain] VETO: {}", signal.veto_reason);
        } else if matches!(signal.action, agents::Direction::Buy | agents::Direction::Sell) {
            info!(
                "[Brain] ★ SIGNAL {:?} │ entry={:.4} TP={:.4} SL={:.4}",
                signal.action, signal.entry, signal.take_profit, signal.stop_loss
            );
        }

        // ── Write signal to SHM → Go executor will pick it up ─────────────
        bridge.write_signal(&signal);
    }
}
