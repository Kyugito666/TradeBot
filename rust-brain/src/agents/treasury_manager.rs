// rust-brain/src/agents/treasury_manager.rs

use crate::shm::MarketSnapshot;

/// TreasuryManager doesn't vote on direction, it calculates position sizing (Allocation Pct).
/// It analyzes volatility (ATR), signal confidence, and current market conditions.
pub struct TreasuryManager;

impl TreasuryManager {
    pub fn calculate_allocation(
        &self,
        snap: &MarketSnapshot,
        signal_confidence: f64,
        risk_reward: f64,
        is_strong_consensus: bool,
        trading_style: &str
    ) -> f64 {
        // Base allocation
        let mut allocation: f64 = 0.02; // 2% default

        // 1. Adjust based on Risk Model / Trading Style
        let style = trading_style.to_lowercase();
        if style.contains("aggressive") || style.contains("scalping") {
            allocation *= 2.0; // Berani ambil porsi 2x lipat
        } else if style.contains("conservative") || style.contains("position") {
            allocation *= 0.5; // Main aman banget, porsi setengah
        } // "balanced" or others stick to 1x

        // 2. Adjust based on AI Confidence (0.0 -> 1.0)
        if signal_confidence >= 0.7 {
            allocation += 0.03; // +3%
        } else if signal_confidence >= 0.5 {
            allocation += 0.015; // +1.5%
        } else if signal_confidence < 0.25 {
            allocation -= 0.01; // -1%
        }

        // 3. Adjust based on Risk-to-Reward (RR)
        if risk_reward >= 3.0 {
            allocation += 0.01;
        } else if risk_reward < 1.0 {
            allocation -= 0.015;
        }

        // 4. Volatility adjustment via ATR14 (Dynamic risk)
        let atr_pct = snap.atr_14 / snap.price.max(1e-9);
        if atr_pct > 0.05 {
            // High volatility -> shrink size
            allocation *= 0.5;
        } else if atr_pct < 0.01 {
            // Low volatility -> bigger size
            allocation *= 1.2;
        }

        // 5. Boost for strong consensus
        if is_strong_consensus {
            allocation *= 1.5;
        }

        // Clamp the allocation between 0.5% and 25%
        allocation.clamp(0.005, 0.25)
    }
}
