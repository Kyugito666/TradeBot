use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct Economist;

impl Agent for Economist {
    fn name(&self) -> &'static str {
        "economist"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        let fr = snap.funding_rate;
        let oi = snap.oi;
        let long_liq = snap.long_liq_1h;
        let short_liq = snap.short_liq_1h;
        
        // 1. Analisis Funding Rate (FR)
        // FR positif tinggi + OI tinggi = Rawan Long Squeeze (Bearish bias)
        // FR negatif tinggi + OI tinggi = Rawan Short Squeeze (Bullish bias)
        // Skalakan FR agar ekuivalen dengan rentang -1.0 ke 1.0
        let fr_score = (fr * 10_000.0).clamp(-1.0, 1.0); 
        
        // 2. Analisis Liquidation Volume
        // Jika short liquidation jauh lebih besar dari long, market mungkin sedang short squeeze (bullish)
        let total_liq = long_liq + short_liq;
        let liq_bias = if total_liq > 1e-5 {
            (short_liq - long_liq) / total_liq
        } else {
            0.0
        };
        
        // Gabungkan bias:
        // FR negatif = bullish (+), FR positif = bearish (-)
        // Liq bias positif = short squeeze = bullish (+)
        let bias = (-fr_score * 0.6) + (liq_bias * 0.4);
        
        let direction = if bias > 0.20 {
            Direction::Buy
        } else if bias < -0.20 {
            Direction::Sell
        } else {
            Direction::Veto
        };
        
        let conviction = bias.abs().min(1.0);
        let reason = format!(
            "FR: {:.5}, OI: {:.0}, LiqBias: {:.2}", 
            fr, oi, liq_bias
        );
        
        if direction == Direction::Veto {
            AgentVote::forced_choice(self.name(), 0.1, 0.1, &reason)
        } else {
            AgentVote {
                agent: self.name(),
                direction,
                conviction,
                reasoning: reason,
            }
        }
    }
}
