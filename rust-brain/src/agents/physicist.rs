// rust-brain/src/agents/physicist.rs
//
// Port of agent_physicist.py — Geometric Brownian Motion simulation.
// Uses rand SmallRng for fast, non-crypto PRNG seeded from system time.
// Runs 1000 × 24-step paths; derives directional bias from P5/P50/P95 spread.

use rand::{rngs::SmallRng, SeedableRng};
use rand_distr::{Distribution, StudentT};

use super::{closes, Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct PhysicistAgent {
    simulations: usize,
    horizon:     usize,
}

impl Default for PhysicistAgent {
    fn default() -> Self { Self { simulations: 1000, horizon: 24 } }
}

impl Agent for PhysicistAgent {
    fn name(&self) -> &'static str { "physicist" }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let c = closes(snap);
        if c.len() < 200 {
            return AgentVote::wait("physicist", "insufficient candles for GBM (need 200+)");
        }

        let price = snap.price;

        // ── Log returns ──────────────────────────────────────────────────────
        let returns: Vec<f64> = c.windows(2)
            .map(|w| (w[1] / w[0]).ln())
            .collect();

        let n   = returns.len() as f64;
        let mu  = returns.iter().sum::<f64>() / n;
        let var = returns.iter().map(|r| (r - mu).powi(2)).sum::<f64>() / n;
        let sig = var.sqrt();

        // ── Volatility crisis check ──────────────────────────────────────────
        // Compare recent 20-period vol vs full-history vol
        let recent_vol = {
            let r = &returns[returns.len().saturating_sub(20)..];
            let m = r.iter().sum::<f64>() / r.len() as f64;
            (r.iter().map(|x| (x-m).powi(2)).sum::<f64>() / r.len() as f64).sqrt()
        };
        let vol_crisis = recent_vol > sig * 3.0;

        if vol_crisis {
            return AgentVote {
                agent:      "physicist",
                direction:  Direction::Wait,
                conviction: 0.0,
                reasoning:  format!(
                    "VOLATILITY CRISIS: recent_vol={:.4} > 3×hist_vol={:.4}",
                    recent_vol, sig * 3.0
                ),
            };
        }

        // ── GBM Monte Carlo ──────────────────────────────────────────────────
        let dt    = 1.0_f64;
        let drift = (mu - 0.5 * sig * sig) * dt;
        let diff  = sig * dt.sqrt();

        let mut rng = SmallRng::seed_from_u64(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .subsec_nanos() as u64,
        );

        let mut final_prices = vec![0.0_f64; self.simulations];
        for fp in final_prices.iter_mut() {
            let mut p = price;
            for _ in 0..self.horizon {
                let z: f64 = StudentT::new(3.0).unwrap().sample(&mut rng);
                p *= (drift + diff * z).exp();
            }
            *fp = p;
        }

        // ── Percentiles ──────────────────────────────────────────────────────
        final_prices.sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
        let p5   = percentile(&final_prices, 5.0);
        let p50  = percentile(&final_prices, 50.0);
        let p95  = percentile(&final_prices, 95.0);
        let spread = p95 - p5;

        let upside_bias = if spread > 1e-8 {
            (p95 - price) / spread
        } else { 0.5 };

        let (dir, conviction) = if upside_bias > 0.62 {
            (Direction::Buy,  (0.4 + (upside_bias - 0.5)).min(0.95))
        } else if upside_bias < 0.38 {
            (Direction::Sell, (0.4 + (0.5 - upside_bias)).min(0.95))
        } else {
            (Direction::Wait, 0.5)
        };

        AgentVote {
            agent:      "physicist",
            direction:  dir,
            conviction,
            reasoning:  format!(
                "GBM P5={:.2} P50={:.2} P95={:.2} upside_bias={:.3} mu={:.5} σ={:.5}",
                p5, p50, p95, upside_bias, mu, sig
            ),
        }
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() { return 0.0; }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

/// Expose vol_crisis for consensus veto
pub fn is_vol_crisis(snap: &MarketSnapshot) -> bool {
    let c = closes(snap);
    if c.len() < 200 { return false; }
    let returns: Vec<f64> = c.windows(2).map(|w| (w[1]/w[0]).ln()).collect();
    let n = returns.len() as f64;
    let mu = returns.iter().sum::<f64>() / n;
    let full_vol = (returns.iter().map(|r|(r-mu).powi(2)).sum::<f64>() / n).sqrt();
    let r20 = &returns[returns.len()-20..];
    let m20 = r20.iter().sum::<f64>() / 20.0;
    let recent_vol = (r20.iter().map(|x|(x-m20).powi(2)).sum::<f64>() / 20.0).sqrt();
    recent_vol > full_vol * 3.0
}
