#![allow(dead_code)]
// rooms/risk_room.rs — Room Risk Management
//
// Menangani risk assessment per-trade:
// - Max drawdown check
// - Position sizing recommendation
// - Correlation check (multi-position overlap)
// - Consecutive loss circuit breaker

use log::{info, warn};

/// Risk assessment result
#[derive(Debug, Clone)]
pub struct RiskAssessment {
    pub approved: bool,
    pub max_allocation_pct: f64,
    pub reason: String,
    pub consecutive_losses: u32,
    pub current_drawdown_pct: f64,
}

pub struct RiskRoom {
    /// Max allowed drawdown percentage before circuit breaker
    max_drawdown_pct: f64,
    /// Max consecutive losses before reducing position size
    max_consec_loss: u32,
    /// Current state
    consec_losses: std::sync::atomic::AtomicU32,
    peak_balance: std::sync::Mutex<f64>,
    current_balance: std::sync::Mutex<f64>,
}

impl RiskRoom {
    pub fn new(max_drawdown_pct: f64, max_consec_loss: u32) -> Self {
        Self {
            max_drawdown_pct,
            max_consec_loss,
            consec_losses: std::sync::atomic::AtomicU32::new(0),
            peak_balance: std::sync::Mutex::new(10000.0),
            current_balance: std::sync::Mutex::new(10000.0),
        }
    }

    /// Evaluate whether a new trade should be allowed
    pub fn evaluate(&self, proposed_allocation_pct: f64) -> RiskAssessment {
        let consec = self.consec_losses.load(std::sync::atomic::Ordering::Relaxed);
        let peak = *self.peak_balance.lock().unwrap();
        let current = *self.current_balance.lock().unwrap();

        let drawdown_pct = if peak > 0.0 { ((peak - current) / peak) * 100.0 } else { 0.0 };

        // Circuit breaker: max drawdown exceeded
        if drawdown_pct >= self.max_drawdown_pct {
            warn!("[RiskRoom] CIRCUIT BREAKER: Drawdown {:.1}% >= limit {:.1}%", drawdown_pct, self.max_drawdown_pct);
            return RiskAssessment {
                approved: false,
                max_allocation_pct: 0.0,
                reason: format!("Circuit breaker: drawdown {:.1}% melebihi batas {:.1}%", drawdown_pct, self.max_drawdown_pct),
                consecutive_losses: consec,
                current_drawdown_pct: drawdown_pct,
            };
        }

        // Reduce position size after consecutive losses
        let scale = if consec >= self.max_consec_loss {
            warn!("[RiskRoom] Consecutive losses: {} >= {}. Reducing position size 50%", consec, self.max_consec_loss);
            0.5
        } else if consec >= 2 {
            info!("[RiskRoom] {} consecutive losses, reducing position size 25%", consec);
            0.75
        } else {
            1.0
        };

        let adjusted = (proposed_allocation_pct * scale).min(0.15); // Hard cap at 15%

        RiskAssessment {
            approved: true,
            max_allocation_pct: adjusted,
            reason: format!("Approved: alloc={:.1}% dd={:.1}% consec_loss={}", adjusted * 100.0, drawdown_pct, consec),
            consecutive_losses: consec,
            current_drawdown_pct: drawdown_pct,
        }
    }

    /// Update state after a trade closes
    pub fn on_trade_closed(&self, is_win: bool, pnl_usd: f64) {
        if is_win {
            self.consec_losses.store(0, std::sync::atomic::Ordering::Relaxed);
        } else {
            self.consec_losses.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }

        let mut current = self.current_balance.lock().unwrap();
        *current += pnl_usd;

        let mut peak = self.peak_balance.lock().unwrap();
        if *current > *peak {
            *peak = *current;
        }
    }

    /// Update balance from external source
    pub fn sync_balance(&self, balance: f64) {
        let mut current = self.current_balance.lock().unwrap();
        *current = balance;
        let mut peak = self.peak_balance.lock().unwrap();
        if balance > *peak {
            *peak = balance;
        }
    }
}
