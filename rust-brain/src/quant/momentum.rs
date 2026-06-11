// quant/momentum.rs — Multi-Timeframe Momentum Signals
//
// HFT-grade momentum analysis:
// - Rate of Change (ROC) multi-period
// - Volume-weighted momentum (VWM)
// - Momentum divergence detector
// - Ehlers Fisher Transform for cycle detection

/// Rate of Change: (price_now - price_n_ago) / price_n_ago * 100
pub fn roc(closes: &[f64], period: usize) -> f64 {
    if closes.len() <= period { return 0.0; }
    let prev = closes[closes.len() - 1 - period];
    if prev.abs() < 1e-10 { return 0.0; }
    ((*closes.last().unwrap() - prev) / prev) * 100.0
}

/// Multi-timeframe momentum: average ROC across multiple periods
/// Returns (short_mom, mid_mom, long_mom, composite)
pub fn multi_tf_momentum(closes: &[f64]) -> (f64, f64, f64, f64) {
    let short = roc(closes, 5);
    let mid = roc(closes, 14);
    let long = roc(closes, 30);
    let composite = short * 0.5 + mid * 0.3 + long * 0.2;
    (short, mid, long, composite)
}

/// Volume-Weighted Momentum: momentum scaled by relative volume
pub fn volume_weighted_momentum(closes: &[f64], volumes: &[f64], period: usize) -> f64 {
    if closes.len() < period + 1 || volumes.len() < period + 1 { return 0.0; }

    let n = closes.len();
    let price_momentum = roc(closes, period);

    // Relative volume: current volume / average volume
    let avg_vol: f64 = volumes[n - period..].iter().sum::<f64>() / period as f64;
    let curr_vol = *volumes.last().unwrap_or(&0.0);
    let rel_vol = if avg_vol > 0.0 { curr_vol / avg_vol } else { 1.0 };

    // Volume-weighted: strong momentum + high volume = strong signal
    price_momentum * rel_vol.min(3.0) // Cap at 3x to avoid outliers
}

/// Momentum divergence: price makes new high/low but momentum doesn't
/// Returns (bullish_div, bearish_div)
pub fn detect_divergence(closes: &[f64], lookback: usize) -> (bool, bool) {
    if closes.len() < lookback + 1 { return (false, false); }

    let n = closes.len();
    let window = &closes[n - lookback..];

    // Find price highs/lows
    let price_high = window.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let price_low = window.iter().cloned().fold(f64::INFINITY, f64::min);
    let curr_price = *closes.last().unwrap();

    // Compute momentum (ROC) at each point
    let mut mom_values = Vec::with_capacity(lookback);
    for i in (n - lookback)..n {
        if i >= 5 {
            let m = ((closes[i] - closes[i - 5]) / closes[i - 5].abs().max(1e-10)) * 100.0;
            mom_values.push(m);
        }
    }

    if mom_values.len() < 3 { return (false, false); }

    let mom_high = mom_values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let mom_low = mom_values.iter().cloned().fold(f64::INFINITY, f64::min);
    let curr_mom = *mom_values.last().unwrap();

    // Bullish divergence: price near low but momentum rising
    let bull_div = (curr_price - price_low).abs() < (price_high - price_low).abs() * 0.2
        && curr_mom > mom_low + (mom_high - mom_low).abs() * 0.3;

    // Bearish divergence: price near high but momentum falling
    let bear_div = (curr_price - price_high).abs() < (price_high - price_low).abs() * 0.2
        && curr_mom < mom_high - (mom_high - mom_low).abs() * 0.3;

    (bull_div, bear_div)
}

/// Ehlers Fisher Transform — converts price to Gaussian distribution
/// Useful for detecting exact turning points
pub fn fisher_transform(closes: &[f64], period: usize) -> (f64, f64) {
    if closes.len() < period + 1 { return (0.0, 0.0); }

    let n = closes.len();
    let window = &closes[n - period..];

    let high = window.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let low = window.iter().cloned().fold(f64::INFINITY, f64::min);

    let range = (high - low).max(1e-10);
    let curr = *closes.last().unwrap();

    // Normalize to [-1, 1]
    let x = ((curr - low) / range * 2.0 - 1.0).clamp(-0.999, 0.999);

    // Fisher transform: 0.5 * ln((1+x)/(1-x))
    let fisher = 0.5 * ((1.0 + x) / (1.0 - x)).ln();

    // Previous bar's fisher
    let prev_price = closes[n - 2];
    let x_prev = ((prev_price - low) / range * 2.0 - 1.0).clamp(-0.999, 0.999);
    let fisher_prev = 0.5 * ((1.0 + x_prev) / (1.0 - x_prev)).ln();

    (fisher, fisher_prev)
}

/// Chande Momentum Oscillator — measures pure momentum without smoothing
pub fn cmo(closes: &[f64], period: usize) -> f64 {
    if closes.len() < period + 1 { return 0.0; }

    let n = closes.len();
    let mut sum_up = 0.0_f64;
    let mut sum_down = 0.0_f64;

    for i in (n - period)..n {
        let diff = closes[i] - closes[i - 1];
        if diff > 0.0 { sum_up += diff; }
        else { sum_down += diff.abs(); }
    }

    let total = sum_up + sum_down;
    if total < 1e-10 { return 0.0; }
    ((sum_up - sum_down) / total) * 100.0 // Range: -100 to +100
}
