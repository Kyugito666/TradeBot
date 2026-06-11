#![allow(dead_code)]
// quant/mean_reversion.rs — Mean Reversion & Volatility Regime Detection
//
// Institutional-grade mean reversion signals:
// - Bollinger Band squeeze (volatility contraction → breakout)
// - Keltner Channel breakout detector
// - Hurst exponent (H < 0.5 = mean-reverting, H > 0.5 = trending)
// - Half-life of mean reversion (how fast price snaps back)

/// Bollinger Band analysis result
#[derive(Debug, Clone)]
pub struct BollingerState {
    pub upper: f64,
    pub middle: f64,
    pub lower: f64,
    pub bandwidth: f64,      // (upper - lower) / middle — volatility measure
    pub percent_b: f64,      // (price - lower) / (upper - lower) — position within bands
    pub squeeze: bool,       // True if bandwidth < threshold (volatility contraction)
    pub squeeze_intensity: f64, // How tight the squeeze is (lower = tighter)
}

/// Compute Bollinger Bands with squeeze detection
pub fn bollinger_bands(closes: &[f64], period: usize, num_std: f64) -> BollingerState {
    let default = BollingerState {
        upper: 0.0, middle: 0.0, lower: 0.0, bandwidth: 0.0,
        percent_b: 0.5, squeeze: false, squeeze_intensity: 1.0,
    };
    if closes.len() < period { return default; }

    let n = closes.len();
    let window = &closes[n - period..];

    let mean: f64 = window.iter().sum::<f64>() / period as f64;
    let var: f64 = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / period as f64;
    let std = var.sqrt();

    let upper = mean + num_std * std;
    let lower = mean - num_std * std;

    let bandwidth = if mean > 0.0 { (upper - lower) / mean } else { 0.0 };
    let band_range = upper - lower;
    let percent_b = if band_range > 1e-10 {
        (*closes.last().unwrap() - lower) / band_range
    } else { 0.5 };

    // Squeeze: compare current bandwidth vs historical average
    let hist_bw = historical_bandwidth(closes, period, num_std, 50);
    let squeeze = bandwidth < hist_bw * 0.75; // Current BW < 75% of average
    let squeeze_intensity = if hist_bw > 0.0 { bandwidth / hist_bw } else { 1.0 };

    BollingerState {
        upper, middle: mean, lower, bandwidth, percent_b,
        squeeze, squeeze_intensity,
    }
}

/// Average bandwidth over lookback period
fn historical_bandwidth(closes: &[f64], bb_period: usize, num_std: f64, lookback: usize) -> f64 {
    if closes.len() < bb_period + lookback { return 0.01; }

    let mut total_bw = 0.0;
    let count = lookback.min(closes.len() - bb_period);

    for i in 0..count {
        let end = closes.len() - i;
        if end < bb_period { break; }
        let window = &closes[end - bb_period..end];
        let mean: f64 = window.iter().sum::<f64>() / bb_period as f64;
        let var: f64 = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / bb_period as f64;
        let std = var.sqrt();
        let bw = if mean > 0.0 { (2.0 * num_std * std) / mean } else { 0.0 };
        total_bw += bw;
    }

    total_bw / count.max(1) as f64
}

/// Keltner Channel analysis
#[derive(Debug, Clone)]
pub struct KeltnerState {
    pub upper: f64,
    pub middle: f64,
    pub lower: f64,
    pub breakout_up: bool,
    pub breakout_down: bool,
}

/// Compute Keltner Channel (EMA ± ATR multiplier)
pub fn keltner_channel(
    closes: &[f64], highs: &[f64], lows: &[f64],
    ema_period: usize, atr_period: usize, atr_mult: f64,
) -> KeltnerState {
    let default = KeltnerState {
        upper: 0.0, middle: 0.0, lower: 0.0,
        breakout_up: false, breakout_down: false,
    };
    if closes.len() < ema_period.max(atr_period) + 1 { return default; }

    // EMA
    let ema = compute_ema(closes, ema_period);

    // ATR (Wilder)
    let atr = crate::agents::wilder_atr(highs, lows, closes, atr_period);

    let upper = ema + atr_mult * atr;
    let lower = ema - atr_mult * atr;
    let price = *closes.last().unwrap();

    KeltnerState {
        upper, middle: ema, lower,
        breakout_up: price > upper,
        breakout_down: price < lower,
    }
}

fn compute_ema(data: &[f64], period: usize) -> f64 {
    if data.is_empty() { return 0.0; }
    if data.len() < period {
        return data.iter().sum::<f64>() / data.len() as f64;
    }
    let k = 2.0 / (period as f64 + 1.0);
    let mut ema = data[..period].iter().sum::<f64>() / period as f64;
    for &v in &data[period..] { ema = v * k + ema * (1.0 - k); }
    ema
}

/// Hurst Exponent via R/S analysis
/// H < 0.5: Mean-reverting | H ≈ 0.5: Random walk | H > 0.5: Trending
pub fn hurst_exponent(closes: &[f64]) -> f64 {
    let n = closes.len();
    if n < 20 { return 0.5; } // Default to random walk

    // Log returns
    let returns: Vec<f64> = closes.windows(2)
        .map(|w| if w[0] > 0.0 { (w[1] / w[0]).ln() } else { 0.0 })
        .collect();

    if returns.len() < 10 { return 0.5; }

    // R/S analysis over multiple block sizes
    let block_sizes: Vec<usize> = vec![8, 16, 32, 64]
        .into_iter()
        .filter(|&s| s <= returns.len())
        .collect();

    if block_sizes.len() < 2 { return 0.5; }

    let mut log_ns = Vec::new();
    let mut log_rs = Vec::new();

    for &block_size in &block_sizes {
        let n_blocks = returns.len() / block_size;
        if n_blocks == 0 { continue; }

        let mut rs_sum = 0.0;
        for b in 0..n_blocks {
            let block = &returns[b * block_size..(b + 1) * block_size];
            let mean: f64 = block.iter().sum::<f64>() / block_size as f64;

            // Cumulative deviations
            let mut cumdev = Vec::with_capacity(block_size);
            let mut cum = 0.0;
            for &r in block {
                cum += r - mean;
                cumdev.push(cum);
            }

            let range = cumdev.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
                      - cumdev.iter().cloned().fold(f64::INFINITY, f64::min);

            let var: f64 = block.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / block_size as f64;
            let std = var.sqrt();

            if std > 1e-15 {
                rs_sum += range / std;
            }
        }

        let avg_rs = rs_sum / n_blocks as f64;
        if avg_rs > 0.0 {
            log_ns.push((block_size as f64).ln());
            log_rs.push(avg_rs.ln());
        }
    }

    // Linear regression: ln(R/S) = H * ln(n) + c
    if log_ns.len() < 2 { return 0.5; }

    let n_pts = log_ns.len() as f64;
    let sum_x: f64 = log_ns.iter().sum();
    let sum_y: f64 = log_rs.iter().sum();
    let sum_xy: f64 = log_ns.iter().zip(log_rs.iter()).map(|(x, y)| x * y).sum();
    let sum_xx: f64 = log_ns.iter().map(|x| x * x).sum();

    let denom = n_pts * sum_xx - sum_x * sum_x;
    if denom.abs() < 1e-15 { return 0.5; }

    let h = (n_pts * sum_xy - sum_x * sum_y) / denom;
    h.clamp(0.0, 1.0)
}

/// Half-life of mean reversion (in bars)
/// Uses Ornstein-Uhlenbeck model: log(price) = a + b*log(price_lag) + noise
/// Half-life = -ln(2) / ln(b)
pub fn half_life(closes: &[f64]) -> f64 {
    if closes.len() < 10 { return f64::INFINITY; }

    let log_prices: Vec<f64> = closes.iter().map(|p| if *p > 0.0 { p.ln() } else { 0.0 }).collect();

    // y = delta(log_price), x = log_price_lag
    let n = log_prices.len() - 1;
    let mut sum_x = 0.0_f64;
    let mut sum_y = 0.0_f64;
    let mut sum_xy = 0.0_f64;
    let mut sum_xx = 0.0_f64;

    for i in 0..n {
        let x = log_prices[i];
        let y = log_prices[i + 1] - log_prices[i];
        sum_x += x;
        sum_y += y;
        sum_xy += x * y;
        sum_xx += x * x;
    }

    let nn = n as f64;
    let denom = nn * sum_xx - sum_x * sum_x;
    if denom.abs() < 1e-15 { return f64::INFINITY; }

    let beta = (nn * sum_xy - sum_x * sum_y) / denom;

    if beta >= 0.0 { return f64::INFINITY; } // Not mean-reverting

    let hl = -(2.0_f64.ln()) / beta.abs();
    hl.max(1.0) // Minimum 1 bar
}
