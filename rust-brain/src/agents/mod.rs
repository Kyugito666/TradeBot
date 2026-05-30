// rust-brain/src/agents/mod.rs

pub mod absurdist;
pub mod cryptographer;
pub mod data_engineer;
pub mod economist;
pub mod game_theorist;
pub mod linguist;
pub mod liquidator;
pub mod mathematician;
pub mod physicist;

use crate::shm::MarketSnapshot;

// ── RE-EXPORT DIRECTION DARI SHM AGAR TIDAK DUPLIKAT ─────────────────────────
pub use crate::shm::Direction;

#[derive(Debug, Clone)]
pub struct AgentVote {
    pub agent:      &'static str,
    pub direction:  Direction,
    pub conviction: f64,  // [0.0, 1.0]
    pub reasoning:  String,
}

impl AgentVote {
    pub fn wait(agent: &'static str, reason: &str) -> Self {
        Self { agent, direction: Direction::Wait, conviction: 0.0, reasoning: reason.into() }
    }
}

// ── Utility: basic stats used by multiple agents ─────────────────────────────

pub fn closes(snap: &MarketSnapshot) -> Vec<f64> {
    snap.candles.iter().map(|c| c.close).collect()
}

pub fn highs(snap: &MarketSnapshot) -> Vec<f64> {
    snap.candles.iter().map(|c| c.high).collect()
}

pub fn lows(snap: &MarketSnapshot) -> Vec<f64> {
    snap.candles.iter().map(|c| c.low).collect()
}

pub fn volumes(snap: &MarketSnapshot) -> Vec<f64> {
    snap.candles.iter().map(|c| c.vol).collect()
}

pub fn rsi(closes: &[f64], period: usize) -> f64 {
    if closes.len() < period + 1 { return 50.0; }

    let deltas: Vec<f64> = closes.windows(2).map(|w| w[1] - w[0]).collect();
    let seed    = &deltas[..period];
    let mut avg_up:   f64 = seed.iter().filter(|&&d| d >= 0.0).sum::<f64>() / period as f64;
    let mut avg_down: f64 = seed.iter().filter(|&&d| d <  0.0).map(|d| -d).sum::<f64>() / period as f64;

    for &d in &deltas[period..] {
        let up   = if d > 0.0 { d } else { 0.0 };
        let down = if d < 0.0 { -d } else { 0.0 };
        avg_up   = (avg_up   * (period as f64 - 1.0) + up)   / period as f64;
        avg_down = (avg_down * (period as f64 - 1.0) + down) / period as f64;
    }

    if avg_down < 1e-10 { return 100.0; }
    100.0 - 100.0 / (1.0 + avg_up / avg_down)
}

pub fn zscore(series: &[f64], window: usize) -> f64 {
    if series.len() < window { return 0.0; }
    let w = &series[series.len() - window..];
    let mean: f64 = w.iter().sum::<f64>() / window as f64;
    let var:  f64 = w.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / window as f64;
    let std         = var.sqrt();
    if std < 1e-10 { return 0.0; }
    (series.last().unwrap() - mean) / std
}

pub fn bayesian_update(prior_up: f64, lik_up: f64, lik_down: f64) -> f64 {
    let prior_down = 1.0 - prior_up;
    let evidence   = lik_up * prior_up + lik_down * prior_down;
    if evidence < 1e-10 { return prior_up; }
    (lik_up * prior_up) / evidence
}

pub fn wilder_atr(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> f64 {
    if closes.len() < 2 { return 0.0; }
    let tr: Vec<f64> = (1..closes.len()).map(|i| {
        let hl  = highs[i]  - lows[i];
        let hpc = (highs[i]  - closes[i-1]).abs();
        let lpc = (lows[i]   - closes[i-1]).abs();
        hl.max(hpc).max(lpc)
    }).collect();

    let seed_n = period.min(tr.len());
    let mut atr = tr[..seed_n].iter().sum::<f64>() / seed_n as f64;
    let alpha   = 1.0 / period as f64;
    for &t in &tr[seed_n..] {
        atr = atr * (1.0 - alpha) + t * alpha;
    }
    atr
}

pub trait Agent: Send + Sync {
    fn name(&self) -> &'static str;
    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote;
}
