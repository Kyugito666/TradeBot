import re

with open("rust-brain/src/consensus/mod.rs", "r", encoding="utf-8") as f:
    code = f.read()

kelly_logic = """        let strong_consensus = (tentative_action == Direction::Buy  && buy_count  >= 4)
                            || (tentative_action == Direction::Sell && sell_count >= 4);

        // ── Kelly Criterion ──────────────────────────────────────────────────
        let team_pnl = self.evolution.team_recent_pnl();
        let mut kelly_f = 0.0;
        let mut kelly_veto = None;
        if !team_pnl.is_empty() {
            let wins = team_pnl.iter().filter(|&&x| x > 0.0).count() as f64;
            let win_rate = wins / team_pnl.len() as f64;
            
            let avg_win = if wins > 0.0 {
                team_pnl.iter().filter(|&&x| x > 0.0).sum::<f64>() / wins
            } else { 0.0 };
            
            let avg_loss = 1.0; // Assume 1R loss standard
            let r = avg_win / avg_loss;
            
            if r > 0.0 {
                kelly_f = win_rate - ((1.0 - win_rate) / r);
            }
            
            if kelly_f < 0.05 && tentative_action != Direction::Wait {
                kelly_veto = Some(format!("Kelly Criterion negatif/rendah (f={:.1}%, W={:.0}%, R={:.2}). VETO trade demi modal!", kelly_f * 100.0, win_rate * 100.0, r));
            }
        }
        
        if let Some(reason) = kelly_veto {
            log::warn!("[Consensus] KELLY VETO: {}", reason);
            return self.make_wait(votes, reason, ts_ms);
        }

        let quant_veto = self.check_quant_veto("""

code = code.replace("""        let strong_consensus = (tentative_action == Direction::Buy  && buy_count  >= 4)
                            || (tentative_action == Direction::Sell && sell_count >= 4);

        let quant_veto = self.check_quant_veto(""", kelly_logic)

with open("rust-brain/src/consensus/mod.rs", "w", encoding="utf-8") as f:
    f.write(code)
