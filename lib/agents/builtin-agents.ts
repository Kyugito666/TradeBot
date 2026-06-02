// ────────────────────────────────────────────────────────────────────────────────
// Built-in Analysis Agents — Quant-style multi-factor analysis
// Each agent is self-contained and can be independently tuned/disabled
// ────────────────────────────────────────────────────────────────────────────────

import { createAgent, agentRegistry } from "./registry"
import type { AgentInput, AgentOutput, AgentVote } from "./types"

// ═══════════════════════════════════════════════════════════════════════════════
// TREND-FOLLOWING AGENTS
// ═══════════════════════════════════════════════════════════════════════════════

// Moving Average Crossover Agent
const maAgent = createAgent({
  id: "ma_cross",
  name: "Moving Average Cross",
  category: "trend",
  weight: 1.2,
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { closes } = input
    const fast = sma(closes, 7)
    const slow = sma(closes, 25)
    const prevFast = sma(closes.slice(0, -1), 7)
    const prevSlow = sma(closes.slice(0, -1), 25)
    
    let vote: AgentVote = "WAIT"
    let confidence = 0
    let reasoning = ""
    
    const crossUp = prevFast <= prevSlow && fast > slow
    const crossDown = prevFast >= prevSlow && fast < slow
    const spread = Math.abs(fast - slow) / slow
    
    if (crossUp) {
      vote = "LONG"
      confidence = Math.min(0.9, 0.5 + spread * 10)
      reasoning = `Bullish MA cross: MA7 (${fast.toFixed(2)}) crossed above MA25 (${slow.toFixed(2)})`
    } else if (crossDown) {
      vote = "SHORT"
      confidence = Math.min(0.9, 0.5 + spread * 10)
      reasoning = `Bearish MA cross: MA7 (${fast.toFixed(2)}) crossed below MA25 (${slow.toFixed(2)})`
    } else if (fast > slow) {
      vote = "LONG"
      confidence = Math.min(0.7, 0.3 + spread * 5)
      reasoning = `Bullish alignment: MA7 above MA25, spread ${(spread * 100).toFixed(2)}%`
    } else if (fast < slow) {
      vote = "SHORT"
      confidence = Math.min(0.7, 0.3 + spread * 5)
      reasoning = `Bearish alignment: MA7 below MA25, spread ${(spread * 100).toFixed(2)}%`
    } else {
      reasoning = "MA convergence, no clear trend"
    }
    
    return {
      agentId: "ma_cross",
      vote,
      confidence,
      reasoning,
      metrics: { fast, slow, spread }
    }
  }
})

// Momentum Agent (Rate of Change)
const momentumAgent = createAgent({
  id: "momentum",
  name: "Momentum ROC",
  category: "trend",
  weight: 1.0,
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { closes } = input
    const roc10 = roc(closes, 10)
    const roc5 = roc(closes, 5)
    
    let vote: AgentVote = "WAIT"
    let confidence = 0
    let reasoning = ""
    
    // Accelerating momentum
    if (roc10 > 1 && roc5 > roc10 * 0.5) {
      vote = "LONG"
      confidence = Math.min(0.85, 0.4 + Math.abs(roc10) / 10)
      reasoning = `Strong bullish momentum: ROC10=${roc10.toFixed(2)}%, accelerating`
    } else if (roc10 < -1 && roc5 < roc10 * 0.5) {
      vote = "SHORT"
      confidence = Math.min(0.85, 0.4 + Math.abs(roc10) / 10)
      reasoning = `Strong bearish momentum: ROC10=${roc10.toFixed(2)}%, accelerating`
    } else if (roc10 > 0.3) {
      vote = "LONG"
      confidence = 0.3 + Math.min(0.4, Math.abs(roc10) / 5)
      reasoning = `Mild bullish momentum: ROC10=${roc10.toFixed(2)}%`
    } else if (roc10 < -0.3) {
      vote = "SHORT"
      confidence = 0.3 + Math.min(0.4, Math.abs(roc10) / 5)
      reasoning = `Mild bearish momentum: ROC10=${roc10.toFixed(2)}%`
    } else {
      reasoning = `Flat momentum: ROC10=${roc10.toFixed(2)}%`
    }
    
    return {
      agentId: "momentum",
      vote,
      confidence,
      reasoning,
      metrics: { roc10, roc5 }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// MEAN REVERSION AGENTS
// ═══════════════════════════════════════════════════════════════════════════════

// RSI Agent
const rsiAgent = createAgent({
  id: "rsi",
  name: "RSI Oscillator",
  category: "mean_revert",
  weight: 1.1,
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { closes } = input
    const rsiVal = rsi(closes, 14)
    
    let vote: AgentVote = "WAIT"
    let confidence = 0
    let reasoning = ""
    
    if (rsiVal >= 70) {
      vote = "SHORT"
      confidence = Math.min(0.85, 0.5 + (rsiVal - 70) / 30)
      reasoning = `RSI overbought at ${rsiVal.toFixed(1)}, potential reversal down`
      if (rsiVal >= 80) {
        vote = "VETO"
        reasoning = `RSI extreme overbought at ${rsiVal.toFixed(1)}, VETO new longs`
      }
    } else if (rsiVal <= 30) {
      vote = "LONG"
      confidence = Math.min(0.85, 0.5 + (30 - rsiVal) / 30)
      reasoning = `RSI oversold at ${rsiVal.toFixed(1)}, potential reversal up`
      if (rsiVal <= 20) {
        vote = "VETO"
        reasoning = `RSI extreme oversold at ${rsiVal.toFixed(1)}, VETO new shorts`
      }
    } else if (rsiVal >= 55 && rsiVal < 70) {
      vote = "LONG"
      confidence = 0.3 + (rsiVal - 55) / 50
      reasoning = `RSI bullish zone at ${rsiVal.toFixed(1)}`
    } else if (rsiVal <= 45 && rsiVal > 30) {
      vote = "SHORT"
      confidence = 0.3 + (45 - rsiVal) / 50
      reasoning = `RSI bearish zone at ${rsiVal.toFixed(1)}`
    } else {
      reasoning = `RSI neutral at ${rsiVal.toFixed(1)}`
    }
    
    return {
      agentId: "rsi",
      vote,
      confidence,
      reasoning,
      metrics: { rsi: rsiVal }
    }
  }
})

// Bollinger Band Agent
const bollingerAgent = createAgent({
  id: "bollinger",
  name: "Bollinger Bands",
  category: "mean_revert",
  weight: 0.9,
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { closes } = input
    const period = 20
    const stdDev = 2
    
    const ma = sma(closes, period)
    const std = standardDeviation(closes.slice(-period))
    const upper = ma + stdDev * std
    const lower = ma - stdDev * std
    const last = closes[closes.length - 1]
    const width = (upper - lower) / ma
    
    let vote: AgentVote = "WAIT"
    let confidence = 0
    let reasoning = ""
    
    const position = (last - lower) / (upper - lower) // 0 = lower, 1 = upper
    
    if (last > upper) {
      vote = "SHORT"
      confidence = Math.min(0.8, 0.5 + (last - upper) / upper * 10)
      reasoning = `Price above upper BB (${upper.toFixed(2)}), overbought`
    } else if (last < lower) {
      vote = "LONG"
      confidence = Math.min(0.8, 0.5 + (lower - last) / lower * 10)
      reasoning = `Price below lower BB (${lower.toFixed(2)}), oversold`
    } else if (position > 0.8) {
      vote = "SHORT"
      confidence = 0.4 + (position - 0.8) * 2
      reasoning = `Price near upper BB at ${(position * 100).toFixed(0)}%`
    } else if (position < 0.2) {
      vote = "LONG"
      confidence = 0.4 + (0.2 - position) * 2
      reasoning = `Price near lower BB at ${(position * 100).toFixed(0)}%`
    } else {
      reasoning = `Price mid-band at ${(position * 100).toFixed(0)}%`
    }
    
    return {
      agentId: "bollinger",
      vote,
      confidence,
      reasoning,
      metrics: { upper, lower, ma, width, position }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// SENTIMENT AGENTS
// ═══════════════════════════════════════════════════════════════════════════════

// Whale Bias Agent (Long/Short Ratio)
const whaleAgent = createAgent({
  id: "whale",
  name: "Whale Sentiment",
  category: "sentiment",
  weight: 0.8,
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { lsr } = input
    
    let vote: AgentVote = "WAIT"
    let confidence = 0
    let reasoning = ""
    
    // LSR > 1 = more longs, often contrarian signal
    if (lsr > 1.3) {
      vote = "SHORT"
      confidence = Math.min(0.7, 0.4 + (lsr - 1.3) * 0.5)
      reasoning = `Extreme long bias (LSR=${lsr.toFixed(2)}), contrarian SHORT`
    } else if (lsr < 0.7) {
      vote = "LONG"
      confidence = Math.min(0.7, 0.4 + (0.7 - lsr) * 0.5)
      reasoning = `Extreme short bias (LSR=${lsr.toFixed(2)}), contrarian LONG`
    } else if (lsr > 1.1) {
      vote = "SHORT"
      confidence = 0.3 + (lsr - 1.1) * 1.5
      reasoning = `Slight long bias (LSR=${lsr.toFixed(2)}), lean SHORT`
    } else if (lsr < 0.9) {
      vote = "LONG"
      confidence = 0.3 + (0.9 - lsr) * 1.5
      reasoning = `Slight short bias (LSR=${lsr.toFixed(2)}), lean LONG`
    } else {
      reasoning = `Balanced sentiment (LSR=${lsr.toFixed(2)})`
    }
    
    return {
      agentId: "whale",
      vote,
      confidence,
      reasoning,
      metrics: { lsr }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// VOLUME/OI AGENTS
// ═══════════════════════════════════════════════════════════════════════════════

// Open Interest Agent
const oiAgent = createAgent({
  id: "open_interest",
  name: "Open Interest Flow",
  category: "volume",
  weight: 0.7,
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { openInterest, closes } = input
    const priceChange = closes.length > 1 
      ? (closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]
      : 0
    
    let vote: AgentVote = "WAIT"
    let confidence = 0.3
    let reasoning = ""
    
    // Rising OI + Rising price = Bullish continuation
    // Rising OI + Falling price = Bearish continuation
    // Falling OI = Position unwinding
    
    const oiBillions = openInterest / 1e9
    
    if (priceChange > 0.005) {
      vote = "LONG"
      confidence = Math.min(0.6, 0.35 + priceChange * 10)
      reasoning = `Price up with OI at $${oiBillions.toFixed(2)}B, bullish flow`
    } else if (priceChange < -0.005) {
      vote = "SHORT"
      confidence = Math.min(0.6, 0.35 + Math.abs(priceChange) * 10)
      reasoning = `Price down with OI at $${oiBillions.toFixed(2)}B, bearish flow`
    } else {
      reasoning = `Neutral price action, OI at $${oiBillions.toFixed(2)}B`
    }
    
    return {
      agentId: "open_interest",
      vote,
      confidence,
      reasoning,
      metrics: { openInterest, priceChange }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// RISK MANAGEMENT AGENTS (VETO POWER)
// ═══════════════════════════════════════════════════════════════════════════════

// Physicist Agent - Detects false breakouts and anomalies
const physicistAgent = createAgent({
  id: "physicist",
  name: "Physicist (Risk Veto)",
  category: "risk",
  weight: 2.0, // High weight for veto power
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { closes, highs, lows } = input
    const n = closes.length
    
    let vote: AgentVote = "WAIT"
    let confidence = 0.5
    let reasoning = ""
    const flags: string[] = []
    
    // Check for rejection wicks (false breakout)
    if (n >= 3) {
      const lastHigh = highs[n - 1]
      const lastLow = lows[n - 1]
      const lastClose = closes[n - 1]
      const lastOpen = closes[n - 2]
      const bodySize = Math.abs(lastClose - lastOpen)
      const upperWick = lastHigh - Math.max(lastClose, lastOpen)
      const lowerWick = Math.min(lastClose, lastOpen) - lastLow
      const totalRange = lastHigh - lastLow
      
      // Upper wick rejection (bearish)
      if (totalRange > 0 && upperWick / totalRange > 0.6) {
        vote = "VETO"
        confidence = 0.8
        flags.push("upper_wick_rejection")
        reasoning = "VETO: Upper wick rejection detected (false breakout up)"
      }
      // Lower wick rejection (bullish but caution)
      else if (totalRange > 0 && lowerWick / totalRange > 0.6) {
        vote = "VETO"
        confidence = 0.8
        flags.push("lower_wick_rejection")
        reasoning = "VETO: Lower wick rejection detected (false breakout down)"
      }
    }
    
    // Check for extreme volatility (ATR spike)
    const atrVal = atr(highs, lows, closes, 14)
    const avgPrice = closes[n - 1]
    const atrPct = avgPrice > 0 ? (atrVal / avgPrice) * 100 : 0
    
    if (atrPct > 5) {
      vote = "VETO"
      confidence = 0.9
      flags.push("extreme_volatility")
      reasoning = `VETO: Extreme volatility (ATR ${atrPct.toFixed(2)}% of price)`
    }
    
    if (vote !== "VETO") {
      reasoning = `Risk check passed. ATR: ${atrPct.toFixed(2)}%`
    }
    
    return {
      agentId: "physicist",
      vote,
      confidence,
      reasoning,
      metrics: { atr: atrVal, atrPct },
      flags
    }
  }
})

// Macro Regime Agent
const regimeAgent = createAgent({
  id: "regime",
  name: "Macro Regime",
  category: "macro",
  weight: 1.0,
  analyze: async (input: AgentInput): Promise<AgentOutput> => {
    const { closes } = input
    const sma50 = sma(closes, 50)
    const sma200 = sma(closes, Math.min(200, closes.length))
    const last = closes[closes.length - 1]
    
    let vote: AgentVote = "WAIT"
    let confidence = 0.4
    let reasoning = ""
    
    // Golden/Death cross zones
    if (sma50 > sma200 && last > sma50) {
      vote = "LONG"
      confidence = 0.6
      reasoning = "Bullish regime: Price > SMA50 > SMA200 (Golden Cross zone)"
    } else if (sma50 < sma200 && last < sma50) {
      vote = "SHORT"
      confidence = 0.6
      reasoning = "Bearish regime: Price < SMA50 < SMA200 (Death Cross zone)"
    } else if (last > sma200) {
      vote = "LONG"
      confidence = 0.4
      reasoning = "Moderately bullish: Price above SMA200"
    } else if (last < sma200) {
      vote = "SHORT"
      confidence = 0.4
      reasoning = "Moderately bearish: Price below SMA200"
    } else {
      reasoning = "Transitional regime, no clear macro trend"
    }
    
    return {
      agentId: "regime",
      vote,
      confidence,
      reasoning,
      metrics: { sma50, sma200, last }
    }
  }
})

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0
  const n = Math.min(period, values.length)
  const slice = values.slice(values.length - n)
  return slice.reduce((a, b) => a + b, 0) / n
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  let gain = 0
  let loss = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  const avgGain = gain / period
  const avgLoss = loss / period
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function roc(closes: number[], lookback = 10): number {
  if (closes.length < lookback + 1) return 0
  const past = closes[closes.length - 1 - lookback]
  if (!past) return 0
  return ((closes[closes.length - 1] - past) / past) * 100
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const n = Math.min(highs.length, lows.length, closes.length)
  if (n < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    )
    if (Number.isFinite(tr)) trs.push(tr)
  }
  if (trs.length === 0) return 0
  const slice = trs.slice(Math.max(0, trs.length - period))
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2))
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / values.length)
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTER ALL AGENTS
// ═══════════════════════════════════════════════════════════════════════════════

export function registerBuiltinAgents(): void {
  // Trend agents
  agentRegistry.register(maAgent)
  agentRegistry.register(momentumAgent)
  agentRegistry.register(regimeAgent)
  
  // Mean reversion agents
  agentRegistry.register(rsiAgent)
  agentRegistry.register(bollingerAgent)
  
  // Sentiment agents
  agentRegistry.register(whaleAgent)
  
  // Volume agents
  agentRegistry.register(oiAgent)
  
  // Risk agents (veto power)
  agentRegistry.register(physicistAgent)
}

// Export individual agents for testing/customization
export {
  maAgent,
  momentumAgent,
  rsiAgent,
  bollingerAgent,
  whaleAgent,
  oiAgent,
  physicistAgent,
  regimeAgent
}
