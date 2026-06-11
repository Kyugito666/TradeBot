#![allow(dead_code)]
// quant/microstructure.rs — Tick-level Market Microstructure Analysis
//
// HFT-grade functions that analyze raw trade ticks for:
// - Volume-Weighted Average Price (VWAP)
// - Order flow imbalance (buy/sell pressure)
// - Tick velocity and acceleration
// - Effective spread estimation
//
// All functions are O(n) single-pass, zero-allocation where possible.

use crate::shm::RawTick;

/// Microstructure analysis result from raw ticks
#[derive(Debug, Clone, Default)]
pub struct MicrostructureSnapshot {
    pub vwap: f64,
    pub buy_volume: f64,
    pub sell_volume: f64,
    /// Order flow imbalance: +1.0 = all buys, -1.0 = all sells, 0.0 = balanced
    pub flow_imbalance: f64,
    /// Trades per second
    pub tick_velocity: f64,
    /// Acceleration of tick velocity (positive = increasing activity)
    pub tick_acceleration: f64,
    /// Volume-weighted buy pressure (0.0 to 1.0)
    pub buy_pressure: f64,
    /// Effective spread estimate in basis points
    pub effective_spread_bps: f64,
    /// Kyle's Lambda — price impact coefficient (price_change / volume)
    pub kyle_lambda: f64,
    /// Trade count
    pub tick_count: usize,
}

/// Compute full microstructure snapshot from raw ticks
pub fn analyze_ticks(ticks: &[RawTick]) -> MicrostructureSnapshot {
    if ticks.is_empty() {
        return MicrostructureSnapshot::default();
    }

    let mut total_pv = 0.0_f64;  // price * volume sum
    let mut total_v = 0.0_f64;   // total volume
    let mut buy_vol = 0.0_f64;
    let mut sell_vol = 0.0_f64;

    for t in ticks {
        let pv = t.price * t.size;
        total_pv += pv;
        total_v += t.size;

        if t.side == 1 { // buy
            buy_vol += t.size;
        } else {
            sell_vol += t.size;
        }
    }

    let vwap = if total_v > 0.0 { total_pv / total_v } else { ticks[0].price };

    // Order flow imbalance: (buy - sell) / (buy + sell)
    let total_flow = buy_vol + sell_vol;
    let flow_imbalance = if total_flow > 0.0 {
        (buy_vol - sell_vol) / total_flow
    } else { 0.0 };

    let buy_pressure = if total_flow > 0.0 { buy_vol / total_flow } else { 0.5 };

    // Tick velocity: trades per second
    let duration_ms = if ticks.len() >= 2 {
        (ticks.last().unwrap().ts_ms - ticks[0].ts_ms).max(1) as f64
    } else { 1000.0 };
    let tick_velocity = (ticks.len() as f64) / (duration_ms / 1000.0);

    // Tick acceleration: compare first half vs second half velocity
    let tick_acceleration = if ticks.len() >= 4 {
        let mid = ticks.len() / 2;
        let first_dur = (ticks[mid - 1].ts_ms - ticks[0].ts_ms).max(1) as f64;
        let second_dur = (ticks.last().unwrap().ts_ms - ticks[mid].ts_ms).max(1) as f64;
        let v1 = mid as f64 / (first_dur / 1000.0);
        let v2 = (ticks.len() - mid) as f64 / (second_dur / 1000.0);
        v2 - v1
    } else { 0.0 };

    // Effective spread estimation (Roll's estimator)
    let effective_spread_bps = estimate_roll_spread(ticks);

    // Kyle's Lambda: price impact per unit volume
    let kyle_lambda = compute_kyle_lambda(ticks);

    MicrostructureSnapshot {
        vwap,
        buy_volume: buy_vol,
        sell_volume: sell_vol,
        flow_imbalance,
        tick_velocity,
        tick_acceleration,
        buy_pressure,
        effective_spread_bps,
        kyle_lambda,
        tick_count: ticks.len(),
    }
}

/// Roll's spread estimator: Spread ≈ 2 * sqrt(-cov(Δp_t, Δp_{t-1}))
fn estimate_roll_spread(ticks: &[RawTick]) -> f64 {
    if ticks.len() < 3 { return 0.0; }

    let returns: Vec<f64> = ticks.windows(2)
        .map(|w| w[1].price - w[0].price)
        .collect();

    if returns.len() < 2 { return 0.0; }

    // Autocovariance at lag 1
    let mean: f64 = returns.iter().sum::<f64>() / returns.len() as f64;
    let mut cov = 0.0;
    for i in 1..returns.len() {
        cov += (returns[i] - mean) * (returns[i - 1] - mean);
    }
    cov /= (returns.len() - 1) as f64;

    // Roll spread = 2 * sqrt(-cov) when cov < 0
    let spread = if cov < 0.0 {
        2.0 * (-cov).sqrt()
    } else {
        0.0 // Positive autocovariance → momentum, spread not estimable
    };

    // Convert to basis points
    let mid_price = ticks[ticks.len() / 2].price;
    if mid_price > 0.0 {
        (spread / mid_price) * 10000.0
    } else { 0.0 }
}

/// Kyle's Lambda: measures permanent price impact
/// Lambda = Cov(ΔP, V_signed) / Var(V_signed)
fn compute_kyle_lambda(ticks: &[RawTick]) -> f64 {
    if ticks.len() < 3 { return 0.0; }

    let mut price_changes = Vec::with_capacity(ticks.len() - 1);
    let mut signed_vols = Vec::with_capacity(ticks.len() - 1);

    for w in ticks.windows(2) {
        let dp = w[1].price - w[0].price;
        let sv = if w[1].side == 1 { w[1].size } else { -w[1].size };
        price_changes.push(dp);
        signed_vols.push(sv);
    }

    let n = price_changes.len() as f64;
    let mean_dp: f64 = price_changes.iter().sum::<f64>() / n;
    let mean_sv: f64 = signed_vols.iter().sum::<f64>() / n;

    let mut cov = 0.0_f64;
    let mut var_sv = 0.0_f64;

    for i in 0..price_changes.len() {
        let dp_dev = price_changes[i] - mean_dp;
        let sv_dev = signed_vols[i] - mean_sv;
        cov += dp_dev * sv_dev;
        var_sv += sv_dev * sv_dev;
    }

    if var_sv.abs() < 1e-15 { return 0.0; }
    cov / var_sv
}

/// Compute VWAP from raw ticks (lightweight version)
pub fn vwap(ticks: &[RawTick]) -> f64 {
    if ticks.is_empty() { return 0.0; }
    let mut pv_sum = 0.0_f64;
    let mut v_sum = 0.0_f64;
    for t in ticks {
        pv_sum += t.price * t.size;
        v_sum += t.size;
    }
    if v_sum > 0.0 { pv_sum / v_sum } else { ticks[0].price }
}

/// Compute TWAP from raw ticks
pub fn twap(ticks: &[RawTick]) -> f64 {
    if ticks.is_empty() { return 0.0; }
    let sum: f64 = ticks.iter().map(|t| t.price).sum();
    sum / ticks.len() as f64
}
