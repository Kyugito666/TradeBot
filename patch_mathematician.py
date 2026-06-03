import re

with open("rust-brain/src/agents/mathematician.rs", "r") as f:
    code = f.read()

# 1. Add rolling_percentile function at the end
code += """

fn rolling_percentile(val: f64, history: &[f64]) -> f64 {
    if history.is_empty() { return 50.0; }
    let count = history.iter().filter(|&&x| x <= val).count();
    (count as f64 / history.len() as f64) * 100.0
}
"""

# 2. Rewrite Evidence 1 (RSI)
old_rsi = """        // ── Evidence 1: RSI (momentum) ───────────────────────────────────────
        let rsi_val = rsi(&c, self.rsi_period);
        let mut prob_up = 0.5_f64;

        if is_strong_uptrend {
            // Trend-following logic
            if rsi_val > 65.0 {
                prob_up = bayesian_update(prob_up, 0.75, 0.25); // Breakout momentum
            } else if rsi_val < 50.0 {
                prob_up = bayesian_update(prob_up, 0.65, 0.35); // Buy the dip
            }
        } else if is_strong_downtrend {
            if rsi_val < 35.0 {
                prob_up = bayesian_update(prob_up, 0.25, 0.75); // Breakdown momentum
            } else if rsi_val > 50.0 {
                prob_up = bayesian_update(prob_up, 0.35, 0.65); // Sell the rip
            }
        } else {
            // Ranging market -> Mean Reversion logic
            if rsi_val < 30.0 {
                prob_up = bayesian_update(prob_up, 0.72, 0.28);
            } else if rsi_val < 45.0 {
                prob_up = bayesian_update(prob_up, 0.57, 0.43);
            } else if rsi_val > 70.0 {
                prob_up = bayesian_update(prob_up, 0.28, 0.72);
            } else if rsi_val > 55.0 {
                prob_up = bayesian_update(prob_up, 0.43, 0.57);
            }
        }"""

new_rsi = """        // ── Evidence 1: RSI (momentum) ───────────────────────────────────────
        let rsi_val = rsi(&c, self.rsi_period);
        
        let mut rsi_history = Vec::with_capacity(200);
        let start_idx = c.len().saturating_sub(200).max(self.rsi_period + 1);
        for i in start_idx..c.len() {
            rsi_history.push(rsi(&c[..=i], self.rsi_period));
        }
        let rsi_pct = rolling_percentile(rsi_val, &rsi_history);
        
        let mut prob_up = 0.5_f64;

        if is_strong_uptrend {
            if rsi_pct >= 90.0 {
                prob_up = bayesian_update(prob_up, 0.75, 0.25);
            } else if rsi_pct <= 10.0 {
                prob_up = bayesian_update(prob_up, 0.65, 0.35);
            }
        } else if is_strong_downtrend {
            if rsi_pct <= 10.0 {
                prob_up = bayesian_update(prob_up, 0.25, 0.75);
            } else if rsi_pct >= 90.0 {
                prob_up = bayesian_update(prob_up, 0.35, 0.65);
            }
        } else {
            if rsi_pct <= 10.0 {
                prob_up = bayesian_update(prob_up, 0.72, 0.28);
            } else if rsi_pct <= 30.0 {
                prob_up = bayesian_update(prob_up, 0.57, 0.43);
            } else if rsi_pct >= 90.0 {
                prob_up = bayesian_update(prob_up, 0.28, 0.72);
            } else if rsi_pct >= 70.0 {
                prob_up = bayesian_update(prob_up, 0.43, 0.57);
            }
        }"""
code = code.replace(old_rsi, new_rsi)


# 3. Rewrite Evidence 2 (Z-score)
old_z = """        // ── Evidence 2: Z-score (mean reversion vs momentum) ─────────────────
        let z = zscore(&c, self.period);

        if is_strong_uptrend {
            if z > 1.5 {
                prob_up = bayesian_update(prob_up, 0.65, 0.35); // Strong upside momentum
            }
        } else if is_strong_downtrend {
            if z < -1.5 {
                prob_up = bayesian_update(prob_up, 0.35, 0.65); // Strong downside momentum
            }
        } else {
            if z < -2.0 {
                prob_up = bayesian_update(prob_up, 0.68, 0.32);
            } else if z < -1.0 {
                prob_up = bayesian_update(prob_up, 0.58, 0.42);
            } else if z > 2.0 {
                prob_up = bayesian_update(prob_up, 0.32, 0.68);
            } else if z > 1.0 {
                prob_up = bayesian_update(prob_up, 0.42, 0.58);
            }
        }"""

new_z = """        // ── Evidence 2: Z-score (mean reversion vs momentum) ─────────────────
        let z = zscore(&c, self.period);
        
        let mut z_history = Vec::with_capacity(200);
        let start_idx_z = c.len().saturating_sub(200).max(self.period);
        for i in start_idx_z..c.len() {
            z_history.push(zscore(&c[..=i], self.period));
        }
        let z_pct = rolling_percentile(z, &z_history);

        if is_strong_uptrend {
            if z_pct >= 90.0 {
                prob_up = bayesian_update(prob_up, 0.65, 0.35);
            }
        } else if is_strong_downtrend {
            if z_pct <= 10.0 {
                prob_up = bayesian_update(prob_up, 0.35, 0.65);
            }
        } else {
            if z_pct <= 10.0 {
                prob_up = bayesian_update(prob_up, 0.68, 0.32);
            } else if z_pct <= 30.0 {
                prob_up = bayesian_update(prob_up, 0.58, 0.42);
            } else if z_pct >= 90.0 {
                prob_up = bayesian_update(prob_up, 0.32, 0.68);
            } else if z_pct >= 70.0 {
                prob_up = bayesian_update(prob_up, 0.42, 0.58);
            }
        }"""
code = code.replace(old_z, new_z)

# 4. Modify reasoning log
code = code.replace(
    'format!(\n                "RSI={:.1} Z={:.2} P(up)={:.3} P(dn)={:.3} noise={:.2} anomaly={anomaly} ATR={:.4}",\n                rsi_val, z, prob_up, prob_down, noise_ratio, atr\n            )',
    'format!(\n                "RSI_Pct={:.1}% Z_Pct={:.1}% P(up)={:.3} P(dn)={:.3} noise={:.2} anomaly={anomaly} ATR={:.4}",\n                rsi_pct, z_pct, prob_up, prob_down, noise_ratio, atr\n            )'
)


with open("rust-brain/src/agents/mathematician.rs", "w") as f:
    f.write(code)
