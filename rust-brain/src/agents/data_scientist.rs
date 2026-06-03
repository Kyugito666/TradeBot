// rust-brain/src/agents/data_scientist.rs

use std::path::Path;
use tract_onnx::prelude::*;
use super::{Agent, AgentVote, Direction, rsi, wilder_atr, closes, highs, lows};
use crate::shm::MarketSnapshot;

pub struct DataScientist {
    model: Option<RunnableModel<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>>,
}

impl Default for DataScientist {
    fn default() -> Self {
        let model_path = "model.onnx";
        let model = if Path::new(model_path).exists() {
            match tract_onnx::onnx()
                .model_for_path(model_path)
                .and_then(|m| m.into_optimized())
                .and_then(|m| m.into_runnable())
            {
                Ok(m) => {
                    log::info!("[DataScientist] Successfully loaded model.onnx");
                    Some(m)
                }
                Err(e) => {
                    log::error!("[DataScientist] Error loading model.onnx: {:?}", e);
                    None
                }
            }
        } else {
            log::warn!("[DataScientist] model.onnx not found. AI agent will remain idle.");
            None
        };

        Self { model }
    }
}

impl DataScientist {
    pub fn new() -> Self {
        Self::default()
    }
}

impl Agent for DataScientist {
    fn name(&self) -> &'static str {
        "data_scientist"
    }

    fn analyze(&self, snap: &MarketSnapshot) -> AgentVote {
        if snap.candles.is_empty() {
            return AgentVote::wait(self.name(), "No data");
        }

        let Some(ref model) = self.model else {
            return AgentVote::wait(self.name(), "Model not loaded");
        };

        let c = closes(snap);
        let h = highs(snap);
        let l = lows(snap);

        if c.len() < 15 {
            return AgentVote::wait(self.name(), "Insufficient data for features");
        }

        // Calculate features
        let last_c = *c.last().unwrap();
        let prev_c = c[c.len() - 2];
        let pct_change = if prev_c > 0.0 { (last_c - prev_c) / prev_c } else { 0.0 };
        
        let rsi_val = rsi(&c, 14);
        let atr_val = wilder_atr(&h, &l, &c, 14);
        let norm_atr = if last_c > 0.0 { atr_val / last_c } else { 0.0 };
        
        let last_v = snap.candles.last().unwrap().vol;
        
        // Feature vector: [PctChange, RSI, NormATR, Volume]
        let tensor = tract_onnx::prelude::tensor2(&[[
            pct_change as f32, 
            (rsi_val / 100.0) as f32, 
            norm_atr as f32, 
            last_v as f32
        ]]);

        // Run inference
        let result = match model.run(tvec!(tensor.into())) {
            Ok(res) => res,
            Err(e) => return AgentVote::wait(self.name(), &format!("Inference error: {:?}", e)),
        };

        let probs = result[0].as_slice::<f32>().unwrap();

        if probs.len() != 3 {
            return AgentVote::wait(self.name(), "Unexpected model output shape");
        }

        let prob_down = probs[0] as f64;
        let prob_wait = probs[1] as f64;
        let prob_up   = probs[2] as f64;

        let mut direction = Direction::Wait;
        let mut max_prob = prob_wait;

        if prob_up > max_prob {
            direction = Direction::Buy;
            max_prob = prob_up;
        }
        if prob_down > max_prob {
            direction = Direction::Sell;
            max_prob = prob_down;
        }

        let conviction = max_prob.clamp(0.0, 1.0);

        AgentVote {
            agent: self.name(),
            direction,
            conviction,
            reasoning: format!("ONNX inference: P(Up)={:.2} P(Dn)={:.2} P(Wt)={:.2}", prob_up, prob_down, prob_wait),
        }
    }
}
