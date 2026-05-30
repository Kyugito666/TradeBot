// rust-brain/src/agents/absurdist.rs
//
// ┌─────────────────────────────────────────────────────────┐
// │  THE ABSURDIST AGENT  — Agent #6  (NEW)                 │
// │                                                         │
// │  "The market is absurd. Trade its absurdity."           │
// │  — Fictional quant at Medallion Fund, probably          │
// │                                                         │
// │  Signals computed:                                      │
// │  1. Liquidation Magnet   — directional cascade risk     │
// │  2. Tether Printer       — USDT supply expansion        │
// │  3. Squeeze Predictor    — funding rate extremes        │
// │  4. Whale Inflow         — large address accumulation   │
// │  5. Kimchi Premium       — retail FOMO proxy            │
// │                                                         │
// │  Each sub-signal scores -1..+1. Weighted mean → vote.   │
// └─────────────────────────────────────────────────────────┘

use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct AbsurdistAgent;

impl Agent for AbsurdistAgent {
    fn name(&self) -> &'static str { "absurdist" }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let mut signals: Vec<(&str, f64, f64)> = Vec::new(); // (name, score, weight)

        // ── 1. Liquidation Magnet ─────────────────────────────────────────────
        // Compares ratio of long vs short liquidations last 1h.
        // If short_liq >> long_liq  → shorts being rekt → price rising (BUY)
        // If long_liq  >> short_liq → longs being rekt  → price falling (SELL)
        let liq_score = {
            let total = snap.long_liq_1h + snap.short_liq_1h;
            if total > 1.0 {
                let short_dom = snap.short_liq_1h / total;  // 0..1
                let long_dom  = snap.long_liq_1h  / total;  // 0..1
                // short_dom > 0.6 → shorts getting liquidated → BUY signal (+)
                // long_dom  > 0.6 → longs getting liquidated  → SELL signal (-)
                if short_dom > 0.6 {
                     (short_dom - 0.5) * 2.0   //  0..+1
                } else if long_dom > 0.6 {
                    -(long_dom  - 0.5) * 2.0   // -1..0
                } else { 0.0 }
            } else { 0.0 }
        };
        signals.push(("LiqMagnet", liq_score, 0.30));

        // ── 2. Tether Printer ──────────────────────────────────────────────────
        // USDT supply expansion → new fiat liquidity entering crypto → BUY.
        // Positive delta_pct = fresh USDT printed = bullish liquidity injection.
        let tether_score = snap.usdt_delta_pct.clamp(-3.0, 3.0) / 3.0;  // -1..+1
        signals.push(("TetherPrinter", tether_score, 0.15));

        // ── 3. Squeeze Predictor — Funding Rate Extreme ───────────────────────
        // Extreme positive funding → overcrowded longs → SHORT SQUEEZE incoming
        //   → longs forced to close → SELL signal.
        // Extreme negative funding → overcrowded shorts → LONG SQUEEZE incoming
        //   → shorts forced to cover → BUY signal.
        let squeeze_score = {
            let fr = snap.funding_rate;
            if fr > 0.001 {
                // Positive: danger of long squeeze → lean SELL
                -(fr * 500.0).min(1.0)
            } else if fr < -0.001 {
                // Negative: danger of short squeeze → lean BUY
                (fr.abs() * 500.0).min(1.0)
            } else { 0.0 }
        };
        signals.push(("SqueezePred", squeeze_score, 0.25));

        // ── 4. Whale Inflow ────────────────────────────────────────────────────
        // Large net inflow to exchange wallets → smart money buying → BUY.
        // Threshold: $10M+ inflow = significant. Caps at $500M.
        let whale_score = {
            let inflow = snap.whale_inflow_usd;
            if inflow > 10_000_000.0 {
                (inflow / 500_000_000.0).min(1.0)
            } else if inflow < -10_000_000.0 {
                // Net outflow → distribution → SELL
                (inflow / 500_000_000.0).max(-1.0)
            } else { 0.0 }
        };
        signals.push(("WhaleInflow", whale_score, 0.20));

        // ── 5. Kimchi Premium ─────────────────────────────────────────────────
        // Korean exchange (Upbit/Bithumb) trades BTC at premium vs Binance.
        // High positive premium = retail FOMO in KR → global BUY signal.
        // Negative premium = Korean discount = bearish sentiment.
        // Historically ranges -5% to +40%; normalise to -1..+1 with ±5% = ±1.
        let kimchi_score = (snap.kimchi_pct / 5.0).clamp(-1.0, 1.0);
        signals.push(("KimchiPrem", kimchi_score, 0.10));

        // ── Weighted Ensemble ─────────────────────────────────────────────────
        let total_weight: f64 = signals.iter().map(|(_, _, w)| w).sum();
        let weighted_score: f64 = signals.iter()
            .map(|(_, s, w)| s * w)
            .sum::<f64>()
            / total_weight;

        let active: Vec<String> = signals.iter()
            .filter(|(_, s, _)| s.abs() > 0.05)
            .map(|(n, s, _)| format!("{n}={s:+.2}"))
            .collect();

        let (dir, conviction) = if weighted_score > 0.15 {
            (Direction::Buy,  weighted_score.min(1.0))
        } else if weighted_score < -0.15 {
            (Direction::Sell, weighted_score.abs().min(1.0))
        } else {
            (Direction::Wait, 0.0)
        };

        AgentVote {
            agent:      "absurdist",
            direction:  dir,
            conviction,
            reasoning:  format!(
                "score={weighted_score:+.3} | active=[{}] | liq={liq_score:+.2} teth={tether_score:+.2} sqz={squeeze_score:+.2} whale={whale_score:+.2} kimchi={kimchi_score:+.2}",
                active.join(", ")
            ),
        }
    }
}
