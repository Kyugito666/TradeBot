// rooms/mod.rs — Tab Architecture: 5-Room Pipeline
//
// Pipeline per tick:
//   1. DiscussionRoom  → 13 agents analyze in parallel → Vec<AgentVote>
//   2. ConsensusEngine  → Weighted voting → SignalOutput (tentative)
//   3. RiskRoom         → Circuit breaker, drawdown check → RiskAssessment
//   4. ExecutionRoom    → Spread check, slippage, order type → ExecutionPlan
//   5. CourierRoom      → Deliver signal, track latency
//
// Shadow trades processed after execution to evaluate agent performance.

pub mod discussion;
pub mod execution;
pub mod risk_room;
pub mod courier;

use crate::shm::{MarketSnapshot, SignalOutput};
use crate::consensus::ConsensusEngine;
use crate::db::DbClient;
use crate::agents::Agent;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::time::Instant;
use log::{debug, info};

use discussion::DiscussionRoom;
use execution::ExecutionRoom;
use risk_room::RiskRoom;
use courier::CourierRoom;



#[allow(dead_code)]
pub struct TabEnvironment {
    pub tab_id: String,
    pub discussion: DiscussionRoom,
    pub execution: ExecutionRoom,
    pub risk: RiskRoom,
    pub courier: CourierRoom,
    pub db_client: Arc<DbClient>,
    pub consensus: ConsensusEngine,
    pub is_real_money: AtomicBool,
}

impl TabEnvironment {
    pub fn new(tab_id: &str, agents: Vec<Arc<dyn Agent + Send + Sync>>, db_client: Arc<DbClient>) -> Self {
        let discussion = DiscussionRoom::new(agents);
        let execution = ExecutionRoom::new();
        let risk = RiskRoom::new(25.0, 5); // 25% max drawdown, 5 consec loss circuit
        let courier = CourierRoom::new();

        let is_live = tab_id == "Signal_Live";
        let consensus = ConsensusEngine::new(db_client.clone(), is_live);

        info!(
            "[Tab:{}] Room architecture initialized: {} agents | Rooms: Discussion→Consensus→Risk→Execution→Courier",
            tab_id, discussion.agent_count()
        );

        Self {
            tab_id: tab_id.to_string(),
            discussion,
            execution,
            risk,
            courier,
            db_client,
            consensus,
            is_real_money: AtomicBool::new(false),
        }
    }

    pub fn process_tick(&self, snap: &MarketSnapshot) -> SignalOutput {
        let t_start = Instant::now();
        let sym = std::str::from_utf8(&snap.symbol).unwrap_or("???").trim_matches('\0');

        // ── ROOM 1: Discussion — All agents analyze in parallel ──────────
        let raw_analysis = self.discussion.analyze(snap);

        // ── ROOM 2: Consensus — Weighted voting + quant veto ─────────────
        let is_real = self.is_real_money.load(Ordering::SeqCst);
        let signal = self.consensus.evaluate(&raw_analysis, snap, is_real, &self.tab_id);

        // ── ROOM 3: Shadow — Track simulated trades (live only) ──────────
        let is_live = self.tab_id == "Signal_Live";
        if is_live {
            self.consensus.process_shadow_trades(snap, signal.veto);
        }

        // ── ROOM 4: Risk — Circuit breaker check (live only) ─────────────
        if is_live && !signal.veto && signal.allocation_pct > 0.0 {
            let risk_check = self.risk.evaluate(signal.allocation_pct);
            if !risk_check.approved {
                debug!("[RiskRoom] Trade blocked: {}", risk_check.reason);
                // Note: we don't override signal here — Go engine handles final execution
                // Risk data is logged for monitoring
            }
        }

        // ── ROOM 5: Courier — Log and track delivery ─────────────────────
        let is_clean_signal = matches!(signal.action, crate::shm::Direction::Buy | crate::shm::Direction::Sell)
            || signal.veto
            || signal.confidence > 0.15;

        if is_live {
            // Log individual agent votes
            for vote in &raw_analysis {
                self.db_client.insert_agent_vote(
                    snap.ts_ms, sym, vote.agent, &format!("{:?}", vote.direction),
                    vote.conviction, &vote.reasoning, is_clean_signal,
                );
            }

            // Log final consensus signal
            if matches!(signal.action, crate::shm::Direction::Buy | crate::shm::Direction::Sell) || signal.veto {
                let final_dir = match signal.action {
                    crate::shm::Direction::Buy => "BUY",
                    crate::shm::Direction::Sell => "SELL",
                    crate::shm::Direction::Veto => "WAIT",
                };
                self.db_client.insert_consensus_signal(
                    snap.ts_ms, sym, final_dir, signal.confidence, &signal.veto_reason,
                );
            }

            // Track delivery latency
            self.courier.record_delivery(t_start);
        }

        debug!(
            "[Tab:{}] Tick processed in {}µs | {} agents | signal={:?}",
            self.tab_id, t_start.elapsed().as_micros(), raw_analysis.len(), signal.action
        );

        signal
    }

    pub fn get_positions(&self) -> std::collections::HashMap<String, Vec<crate::consensus::ShadowTrade>> {
        self.consensus.get_positions()
    }

    /// Get courier delivery stats (total_delivered, last_latency_us)
    #[allow(dead_code)]
    pub fn delivery_stats(&self) -> (u64, u64) {
        self.courier.stats()
    }

    /// Notify risk room of trade closure
    #[allow(dead_code)]
    pub fn on_trade_closed(&self, is_win: bool, pnl_usd: f64) {
        self.risk.on_trade_closed(is_win, pnl_usd);
    }
}
