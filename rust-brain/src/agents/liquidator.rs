// rust-brain/src/agents/liquidator.rs
//
// Port of analytical_engine/liquidation.py — Liquidation Cluster Engine.
// Estimates where forced-close cascades are densest using OHLCV + OI.
// Acts as a price-magnet signal: dense cluster above = BUY magnet.

use super::{highs, lows, closes, volumes, wilder_atr, Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

// Empirical leverage distribution (Binance/Bybit stats)
const LEV_TIERS:   [f64; 7] = [2.0, 5.0, 10.0, 20.0, 25.0, 50.0, 100.0];
const LEV_WEIGHTS: [f64; 7] = [0.04, 0.12, 0.30, 0.28, 0.12, 0.09, 0.05];
const MMR: f64 = 0.004; // Maintenance margin rate tier-1

pub struct LiquidatorAgent;

impl Agent for LiquidatorAgent {
    fn name(&self) -> &'static str { "liquidator" }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let n = snap.candles.len();
        if n < 20 || snap.oi < 1.0 {
            return AgentVote::wait("liquidator", "insufficient data for liq estimation");
        }

        let h  = highs(snap);
        let l  = lows(snap);
        let c  = closes(snap);
        let v  = volumes(snap);
        let atr = wilder_atr(&h, &l, &c, 14);
        let current = snap.price;
        let oi_usd   = snap.oi * current;
        let lsr      = snap.lsr.max(1e-6);
        let long_frac  = lsr / (1.0 + lsr);
        let short_frac = 1.0 - long_frac;
        let vol_total: f64 = v.iter().sum();

        if vol_total < 1.0 { return AgentVote::wait("liquidator", "zero volume"); }

        // ── Build liquidation price distributions ─────────────────────────────
        let mut long_liq_prices:  Vec<(f64, f64)> = Vec::new(); // (price, weight)
        let mut short_liq_prices: Vec<(f64, f64)> = Vec::new();

        for (i, candle) in snap.candles.iter().enumerate() {
            let vwap   = (candle.high + candle.low + candle.close) / 3.0;
            let vol_w  = v[i] / vol_total;
            let oi_can = oi_usd * vol_w;

            for (j, &lev) in LEV_TIERS.iter().enumerate() {
                let lev_w   = LEV_WEIGHTS[j];
                let weight  = oi_can * lev_w;

                let long_liq  = vwap * (1.0 - 1.0/lev + MMR);
                let short_liq = vwap * (1.0 + 1.0/lev - MMR);

                long_liq_prices.push((long_liq,  weight * long_frac));
                short_liq_prices.push((short_liq, weight * short_frac));
            }
        }

        // ── Find nearest cluster above (short liq = BUY magnet) ──────────────
        let nearest_above = short_liq_prices.iter()
            .filter(|(p, _)| *p > current && (*p - current) < atr * 2.0)
            .min_by(|a, b| (a.0 - current).partial_cmp(&(b.0 - current)).unwrap());

        // ── Find nearest cluster below (long liq = SELL magnet) ──────────────
        let nearest_below = long_liq_prices.iter()
            .filter(|(p, _)| *p < current && (current - *p) < atr * 2.0)
            .min_by(|a, b| (current - a.0).partial_cmp(&(current - b.0)).unwrap());

        // ── Evaluate directional magnet based on proximity and density ────────
        let (dir, conv, detail) = match (nearest_above, nearest_below) {
            (Some(&(ap, aw)), Some(&(bp, bw))) => {
                let dist_above = ap - current;
                let dist_below = current - bp;
                let density_above = (aw / oi_usd).min(1.0);
                let density_below = (bw / oi_usd).min(1.0);

                // Score = density / distance (higher is a stronger magnet)
                let score_above = density_above / dist_above.max(1e-8);
                let score_below = density_below / dist_below.max(1e-8);

                if score_above > score_below * 1.2 {
                    (Direction::Buy, density_above,
                     format!("SHORT_cluster above @ {:.2} (dist={:.2} ATR={:.4} score={:.4})", ap, dist_above, atr, score_above))
                } else if score_below > score_above * 1.2 {
                    (Direction::Sell, density_below,
                     format!("LONG_cluster below @ {:.2} (dist={:.2} ATR={:.4} score={:.4})", bp, dist_below, atr, score_below))
                } else {
                    (Direction::Wait, 0.0, "clusters above and below are balanced".into())
                }
            }
            (Some(&(ap, aw)), None) => {
                let density = (aw / oi_usd).min(1.0);
                (Direction::Buy, density,
                 format!("SHORT_cluster above @ {:.2} (dist={:.2} ATR={:.4})", ap, ap - current, atr))
            }
            (None, Some(&(bp, bw))) => {
                let density = (bw / oi_usd).min(1.0);
                (Direction::Sell, density,
                 format!("LONG_cluster below @ {:.2} (dist={:.2} ATR={:.4})", bp, current - bp, atr))
            }
            (None, None) => (Direction::Wait, 0.0, "no cluster in ATR×2 radius".into()),
        };

        AgentVote {
            agent:      "liquidator",
            direction:  dir,
            conviction: conv,
            reasoning:  detail,
        }
    }
}
