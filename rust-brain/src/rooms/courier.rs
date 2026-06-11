#![allow(dead_code)]
// rooms/courier.rs — Room Courier: Signal Delivery & Logging
//
// Handles the final step: delivering signals to the gateway and logging.
// Responsibilities:
// - Format signal for SHM bridge
// - Log signal to database
// - Track signal delivery latency

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;
use log::info;

pub struct CourierRoom {
    signals_delivered: AtomicU64,
    last_delivery_us: AtomicU64,
}

impl CourierRoom {
    pub fn new() -> Self {
        Self {
            signals_delivered: AtomicU64::new(0),
            last_delivery_us: AtomicU64::new(0),
        }
    }

    /// Record a signal delivery
    pub fn record_delivery(&self, processing_start: Instant) {
        let latency_us = processing_start.elapsed().as_micros() as u64;
        self.signals_delivered.fetch_add(1, Ordering::Relaxed);
        self.last_delivery_us.store(latency_us, Ordering::Relaxed);
    }

    /// Get delivery stats
    pub fn stats(&self) -> (u64, u64) {
        (
            self.signals_delivered.load(Ordering::Relaxed),
            self.last_delivery_us.load(Ordering::Relaxed),
        )
    }

    /// Log delivery summary
    pub fn log_summary(&self) {
        let (delivered, last_us) = self.stats();
        info!("[Courier] Signals delivered: {} | Last latency: {}µs", delivered, last_us);
    }
}
