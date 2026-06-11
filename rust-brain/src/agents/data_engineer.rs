use super::{Agent, AgentVote, Direction};
use crate::shm::MarketSnapshot;

pub struct DataEngineer;

impl Agent for DataEngineer {
    fn name(&self) -> &'static str {
        "data_engineer"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        // 1. Validasi eksistensi data
        if snap.candles.is_empty() {
            return AgentVote::forced_choice(self.name(), 0.1, 0.1, "Missing candles data");
        }
        
        // 2. Validasi anomali harga
        if snap.price <= 0.0 {
            return AgentVote::forced_choice(self.name(), 0.1, 0.1, "Invalid price (<= 0.0)");
        }
        
        // 3. Deteksi Stale Data / Flatline
        // Jika 5 candle berturut-turut harganya sama persis, kemungkinan feed mati/nyangkut.
        if snap.candles.len() >= 5 {
            let last_idx = snap.candles.len() - 1;
            let mut all_same = true;
            for i in (last_idx - 4)..=last_idx {
                if (snap.candles[i].close - snap.price).abs() > 1e-8 {
                    all_same = false;
                    break;
                }
            }
            if all_same {
                return AgentVote::forced_choice(self.name(), 0.1, 0.1, "Stale data: flatline detected in last 5 candles");
            }
        }
        
        // 4. Deteksi Gap yang tidak wajar (Flash crash / Flash pump error spike)
        let last_candle = &snap.candles[snap.candles.len() - 1];
        let pct_change = (last_candle.close - last_candle.open).abs() / last_candle.open;
        if pct_change > 0.15 { // 15% move dalam 1 candle biasanya glitch data
            return AgentVote::forced_choice(self.name(), 0.1, 0.1, "Data spike anomaly (>15% in single candle)");
        }
        
        // 5. Validasi Timestamp Latency Drift
        // Menghitung delta antara waktu sistem saat ini dan timestamp data dari SHM.
        // Trade-off performa: SystemTime::now() memiliki overhead berupa syscall ringan (vDSO di Linux). 
        // Namun, biayanya sangat rendah (~20-50 nanodetik) sehingga aman untuk HFT / low latency.
        if let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
            let now_ms = now.as_millis() as i64;
            let drift = now_ms - snap.ts_ms;
            
            // Batas maksimal toleransi adalah 2000ms
            if drift > 2000 {
                return AgentVote::forced_choice(self.name(), 0.1, 0.1, &format!("High latency drift: {}ms (> 2000ms). Blocking execution.", drift)
                );
            } else if drift < -2000 {
                return AgentVote::forced_choice(self.name(), 0.1, 0.1, &format!("Negative time drift: {}ms. Possible clock desync.", drift)
                );
            }
        }
        
        // Data lolos sanitasi, Agent ini hanya bertugas mem-veto (Wait) jika data buruk.
        // Jika bagus, conviction 0.0 agar tidak mempengaruhi vote.
        AgentVote {
            agent: self.name(),
            direction: Direction::Veto,
            conviction: 0.0,
            reasoning: "Data Sanitized & Validated".to_string(),
        }
    }
}
