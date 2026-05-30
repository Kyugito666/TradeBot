use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct GameTheorist;

impl Agent for GameTheorist {
    fn name(&self) -> &'static str {
        "game_theorist"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        // Karena struktur MarketSnapshot tidak memiliki bid_depth secara eksplisit, 
        // kita menggunakan asumsi bahwa field `bid` dan `ask` di mapping sebagai depth/liquidity
        // (Atau jika ia berupa harga, kita tetap mensimulasikan order book imbalance).
        let bid_depth = snap.bid;
        let ask_depth = snap.ask;
        
        let total_depth = bid_depth + ask_depth;
        if total_depth < 1e-9 {
            return AgentVote::wait(self.name(), "Zero order book depth");
        }
        
        // Order Book Imbalance (OBI) = (bid_depth - ask_depth) / (bid_depth + ask_depth)
        // Skala: -1.0 (Full Ask Dinding) hingga 1.0 (Full Bid Dinding)
        let obi = (bid_depth - ask_depth) / total_depth;
        
        // Deteksi Spoofing sederhana:
        // Jika OBI sangat positif tapi harga justru drop signifikan dari MA/Candle sebelumnya,
        // itu bisa jadi dinding bid palsu (spoofing).
        // Untuk sekarang, kita hitung bias linear dari OBI.
        let bias = obi;
        let conviction = bias.abs().min(1.0);
        
        let direction = if bias > 0.15 {
            Direction::Buy
        } else if bias < -0.15 {
            Direction::Sell
        } else {
            Direction::Wait
        };
        
        let reason = format!("OBI: {:.3} (Bid: {:.1}, Ask: {:.1})", obi, bid_depth, ask_depth);
        
        if direction == Direction::Wait {
            AgentVote::wait(self.name(), &reason)
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
