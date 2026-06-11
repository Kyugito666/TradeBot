#![allow(dead_code)]
// rooms/execution.rs — Room Eksekusi: Signal Execution with Quant Filters
//
// Takes consensus signal and applies final execution-level filters:
// - Spread check (bid-ask too wide?)
// - Slippage estimation
// - Entry timing optimization (wait for pullback or market order?)
// - Final entry/TP/SL adjustment

use crate::shm::MarketSnapshot;
use log::info;

#[derive(Debug, Clone)]
pub struct ExecutionPlan {
    pub entry: f64,
    pub take_profit: f64,
    pub stop_loss: f64,
    pub order_type: OrderType,
    pub spread_ok: bool,
    pub estimated_slippage_bps: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrderType {
    Limit,
    Market,
}

pub struct ExecutionRoom;

impl ExecutionRoom {
    pub fn new() -> Self { Self }

    /// Refine a signal into an execution plan
    pub fn plan_execution(
        &self,
        snap: &MarketSnapshot,
        entry: f64,
        tp: f64,
        sl: f64,
        is_buy: bool,
    ) -> ExecutionPlan {
        let spread = (snap.ask - snap.bid).abs();
        let spread_pct = if snap.price > 0.0 { (spread / snap.price) * 100.0 } else { 0.0 };

        // Spread check: reject if spread > 0.15% (too wide for scalping)
        let spread_ok = spread_pct < 0.15;

        // Estimate slippage based on spread
        let slippage_bps = spread_pct * 50.0; // rough estimate: half spread as slippage

        // Order type: use Limit if spread is tight, Market if need immediate fill
        let order_type = if spread_pct < 0.05 {
            OrderType::Market // Tight spread, market order fine
        } else {
            OrderType::Limit // Wide spread, use limit to avoid slippage
        };

        // Adjust entry for limit orders: place slightly better than market
        let adjusted_entry = if order_type == OrderType::Limit {
            if is_buy {
                // Place limit slightly below current price
                (snap.bid + entry) / 2.0
            } else {
                // Place limit slightly above current price
                (snap.ask + entry) / 2.0
            }
        } else {
            entry
        };

        if !spread_ok {
            info!("[ExecRoom] ⚠ Spread terlalu lebar: {:.4}% — consider delay", spread_pct);
        }

        ExecutionPlan {
            entry: adjusted_entry,
            take_profit: tp,
            stop_loss: sl,
            order_type,
            spread_ok,
            estimated_slippage_bps: slippage_bps,
        }
    }
}
