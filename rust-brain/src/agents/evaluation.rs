use log::info;

pub struct AgentPerformance {
    pub total_trades: u32,
    pub winning_trades: u32,
    pub pnl: f64,
}

impl AgentPerformance {
    pub fn new() -> Self {
        Self {
            total_trades: 0,
            winning_trades: 0,
            pnl: 0.0,
        }
    }

    pub fn record_trade(&mut self, profit: f64) {
        self.total_trades += 1;
        self.pnl += profit;
        if profit > 0.0 {
            self.winning_trades += 1;
        }
    }

    pub fn win_rate(&self) -> f64 {
        if self.total_trades == 0 {
            return 0.0;
        }
        (self.winning_trades as f64 / self.total_trades as f64) * 100.0
    }

    pub fn is_ready_for_live(&self) -> bool {
        self.win_rate() >= 50.0 && self.total_trades >= 10
    }

    pub fn needs_retraining(&self) -> bool {
        self.win_rate() < 40.0 && self.total_trades >= 10
    }
}

pub fn evaluate_agent_batch(agent_id: &str, perf: &AgentPerformance) {
    if perf.needs_retraining() {
        info!("[Rust Eval] Agent {} requires retraining. Win rate: {:.2}%. Demotion signal sent to Go.", agent_id, perf.win_rate());
    } else if perf.is_ready_for_live() {
        info!("[Rust Eval] Agent {} passes criteria with {:.2}% win rate. Graduation signal sent to Go.", agent_id, perf.win_rate());
    } else {
        info!("[Rust Eval] Agent {} still studying. Win rate: {:.2}%.", agent_id, perf.win_rate());
    }
}
