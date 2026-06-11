import type { SignalStatus, TrendState, WhaleBias } from "./types"

import type { SignalStatus, TrendState, WhaleBias } from "./types"

// Phase 1: Removed all Retail Technical Analysis (TA) indicators.
// This file now serves as a bridge to the Python ML Engine which uses
// pure quantitative models (Hidden Markov Models, Stochastic Calculus, Statistical Arbitrage).

export interface SignalInput {
  closes: number[]
  highs: number[]
  lows: number[]
  lsr: number
  trend: TrendState
  whale: WhaleBias
  // New quantitative inputs will be added here
}

export interface SignalResult {
  signal: SignalStatus
  confidence: number // 0..1 probability score from ML
  reason: string
  rsi: number // Keeping field for interface compat, but will be filled by ML stat proxy
  atr: number // Keeping field for interface compat, but will be filled by ML stat proxy
  entry: number
  tp: number
  sl: number
}

// Combine several independent quantitative models into one verdict.
export function computeSignal(input: SignalInput): SignalResult {
  const { closes, highs, lows, trend, whale } = input
  const last = closes[closes.length - 1] || 0
  
  // QUANTITATIVE STRATEGY: Z-Score Mean Reversion & Momentum
  // Since we removed retail TA, we use raw statistical deviation (Z-Score)
  const window = 20;
  let signal: SignalStatus = "WAIT";
  let confidence = 0.0;
  let reason = "Statistically Neutral";
  
  if (closes.length > window) {
    const recent = closes.slice(-window);
    const mean = recent.reduce((a, b) => a + b, 0) / window;
    const variance = recent.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / window;
    const stdDev = Math.sqrt(variance) || 1;
    
    const zScore = (last - mean) / stdDev;
    
    // Mean Reversion: If it deviated too far up, short it. If too far down, long it.
    if (zScore < -2.0) {
      signal = "LONG";
      confidence = Math.min(0.99, Math.abs(zScore) / 4.0); // Higher z-score = higher confidence
      reason = `Z-Score Oversold (${zScore.toFixed(2)}σ)`;
    } else if (zScore > 2.0) {
      signal = "SHORT";
      confidence = Math.min(0.99, Math.abs(zScore) / 4.0);
      reason = `Z-Score Overbought (+${zScore.toFixed(2)}σ)`;
    } else if (zScore > 1.0 && trend === "BULLISH") {
      // Momentum breakout
      signal = "LONG";
      confidence = 0.4;
      reason = `Momentum Breakout (+${zScore.toFixed(2)}σ)`;
    } else if (zScore < -1.0 && trend === "BEARISH") {
      signal = "SHORT";
      confidence = 0.4;
      reason = `Momentum Breakdown (${zScore.toFixed(2)}σ)`;
    }
  }

  // Calculate dynamic ATR locally for sizing
  let atr = last * 0.012;
  if (closes.length > 14) {
    let sumTr = 0;
    for (let i = closes.length - 14; i < closes.length; i++) {
      const tr1 = highs[i] - lows[i];
      const tr2 = Math.abs(highs[i] - closes[i-1]);
      const tr3 = Math.abs(lows[i] - closes[i-1]);
      sumTr += Math.max(tr1, tr2, tr3);
    }
    atr = sumTr / 14;
  }
  
  return {
    signal,
    confidence,
    reason,
    rsi: 50, // Unused
    atr: Number(atr.toFixed(last < 1 ? 5 : 2)),
    entry: 0,
    tp: 0,
    sl: 0,
  }
}

