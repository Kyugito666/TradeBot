// ────────────────────────────────────────────────────────────────────────────────
// Built-in Analysis Agents — QUANT team (Jim Simons / Renaissance inspired).
//
// DESIGN PRINCIPLES (this rewrite):
//   • NO RSI and no "indicator soup". Every agent uses simple-but-strong statistical
//     / order-flow logic computed from data we ACTUALLY have (OHLCV, OI, funding,
//     long/short ratio, order-book depth).
//   • Every agent is ACTIVE: there are no agents that just sit and WAIT because a
//     sentiment/whale/liquidation feed is missing. Each one always produces a real
//     directional read from price/volume/derivatives data.
//   • Each agent reports an `activity` string so the UI can show, in real time, what
//     it is currently analysing.
//
// Adding a new agent = add a config entry + a builder in AGENT_BUILDERS.
// ────────────────────────────────────────────────────────────────────────────────

import { createAgent, agentRegistry } from "./registry"
import { AGENT_TEAM_CONFIG } from "./config"
import type { AgentInput, AgentOutput, AgentVote, IAgent } from "./types"

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED QUANT MATH (pure price/volume statistics — no oscillator indicators)
// ═══════════════════════════════════════════════════════════════════════════════

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0
  const n = Math.min(period, values.length)
  const slice = values.slice(values.length - n)
  return slice.reduce((a, b) => a + b, 0) / n
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function std(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length)
}

function zscore(series: number[], window: number): number {
  if (series.length < window) return 0
  const w = series.slice(series.length - window)
  const m = mean(w)
  const s = std(w)
  if (s < 1e-10) return 0
  return (series[series.length - 1] - m) / s
}

// Log returns of a close series.
function logReturns(closes: number[]): number[] {
  const r: number[] = []
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]))
  }
  return r
}

// Kaufman Efficiency Ratio over the last `period` closes: directional travel ÷ total
// path. ~1 = clean trend, ~0 = choppy noise. The core regime filter (no RSI).
function efficiencyRatio(closes: number[], period: number): number {
  const n = Math.min(period, closes.length - 1)
  if (n <= 0) return 0
  const change = Math.abs(closes[closes.length - 1] - closes[closes.length - 1 - n])
  let vol = 0
  for (let i = closes.length - n; i < closes.length; i++) vol += Math.abs(closes[i] - closes[i - 1])
  if (vol < 1e-9) return 0
  return change / vol
}

// Ordinary least-squares slope + R² over an index-vs-value series.
function linreg(values: number[]): { slope: number; r2: number } {
  const n = values.length
  if (n < 3) return { slope: 0, r2: 0 }
  const xs = Array.from({ length: n }, (_, i) => i)
  const mx = (n - 1) / 2
  const my = mean(values)
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (values[i] - my)
    sxx += (xs[i] - mx) ** 2
    syy += (values[i] - my) ** 2
  }
  if (sxx < 1e-12) return { slope: 0, r2: 0 }
  const slope = sxy / sxx
  const r2 = syy < 1e-12 ? 0 : (sxy * sxy) / (sxx * syy)
  return { slope, r2 }
}

function bayesianUpdate(priorUp: number, likUp: number, likDown: number): number {
  const priorDown = 1 - priorUp
  const evidence = likUp * priorUp + likDown * priorDown
  if (evidence < 1e-10) return priorUp
  return (likUp * priorUp) / evidence
}

function wilderAtr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (closes.length < 2) return 0
  const tr: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const hl = highs[i] - lows[i]
    const hpc = Math.abs(highs[i] - closes[i - 1])
    const lpc = Math.abs(lows[i] - closes[i - 1])
    tr.push(Math.max(hl, hpc, lpc))
  }
  const seedN = Math.min(period, tr.length)
  let atr = tr.slice(0, seedN).reduce((a, b) => a + b, 0) / seedN
  const alpha = 1 / period
  for (const t of tr.slice(seedN)) atr = atr * (1 - alpha) + t * alpha
  return atr
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.round((p / 100) * (sorted.length - 1))
  return sorted[Math.min(idx, sorted.length - 1)]
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function tanh(x: number): number {
  return Math.tanh(x)
}

// Directional vote from a signed score in [-1,1] with a small dead-zone.
function voteFromScore(score: number, deadzone = 0.12): { vote: AgentVote; confidence: number } {
  if (score > deadzone) return { vote: "LONG", confidence: clamp(Math.abs(score), 0, 1) }
  if (score < -deadzone) return { vote: "SHORT", confidence: clamp(Math.abs(score), 0, 1) }
  return { vote: "WAIT", confidence: clamp(Math.abs(score) / deadzone * 0.2, 0, 0.2) }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MATHEMATICIAN — Bayesian regime-aware probability (momentum + mean reversion)
// ═══════════════════════════════════════════════════════════════════════════════
async function mathematician(input: AgentInput): Promise<AgentOutput> {
  const id = "mathematician"
  const activity = "Bayesian regime probability (efficiency ratio + z-score + drift)"
  const c = input.closes
  const period = 14
  if (c.length < period + 2) return weakWait(id, "insufficient candles", activity)

  const er = efficiencyRatio(c, period)
  const last = c[c.length - 1]
  const prev = c[c.length - 1 - Math.min(period, c.length - 1)]
  const trendUp = last > prev
  const trending = er > 0.35

  const z = zscore(c, period)
  let probUp = 0.5

  if (trending) {
    // Trend-following: ride the dominant direction, strength scaled by efficiency.
    if (trendUp) probUp = bayesianUpdate(probUp, 0.5 + er * 0.4, 0.5 - er * 0.4)
    else probUp = bayesianUpdate(probUp, 0.5 - er * 0.4, 0.5 + er * 0.4)
  } else {
    // Mean reversion when choppy: fade extreme z-scores back to the mean.
    if (z < -2) probUp = bayesianUpdate(probUp, 0.72, 0.28)
    else if (z < -1) probUp = bayesianUpdate(probUp, 0.6, 0.4)
    else if (z > 2) probUp = bayesianUpdate(probUp, 0.28, 0.72)
    else if (z > 1) probUp = bayesianUpdate(probUp, 0.4, 0.6)
  }

  // Short-horizon drift confirmation.
  const rets = logReturns(c.slice(-period))
  const drift = mean(rets)
  if (drift > 0) probUp = bayesianUpdate(probUp, 0.56, 0.44)
  else if (drift < 0) probUp = bayesianUpdate(probUp, 0.44, 0.56)

  const probDown = 1 - probUp
  const atr = wilderAtr(input.highs, input.lows, c, period)

  // Noise + anomaly diagnostics (used by the risk veto layer; replaces RSI noise).
  const lc = input.candles[input.candles.length - 1]
  const bodyLast = lc ? Math.abs(lc.close - lc.open) : 0
  const rangeLast = lc ? lc.high - lc.low : 1
  const noiseRatio = rangeLast > 1e-9 ? (rangeLast - bodyLast) / rangeLast : 0
  const anomaly = Math.abs(z) > 4

  let vote: AgentVote = "WAIT"
  let confidence = 0
  if (probUp > 0.56) { vote = "LONG"; confidence = (probUp - 0.5) * 2 }
  else if (probDown > 0.56) { vote = "SHORT"; confidence = (probDown - 0.5) * 2 }
  confidence = clamp(confidence, 0, 1)

  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `ER=${er.toFixed(2)} ${trending ? "TREND" : "RANGE"} Z=${z.toFixed(2)} drift=${drift.toFixed(4)} P(up)=${probUp.toFixed(2)}`,
    metrics: { er, z, probUp, noise: noiseRatio, anomaly: anomaly ? 1 : 0, atr },
    flags: anomaly ? ["anomaly"] : [],
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PHYSICIST — GBM Monte Carlo upside bias, VETOs on volatility crisis
// ═══════════════════════════════════════════════════════════════════════════════
async function physicist(input: AgentInput): Promise<AgentOutput> {
  const id = "physicist"
  const activity = "Monte Carlo GBM forecast (1000 paths) + volatility-regime guard"
  const c = input.closes
  if (c.length < 30) return weakWait(id, "insufficient candles for GBM", activity)
  const price = input.price

  const returns = logReturns(c)
  const nr = returns.length
  const mu = mean(returns)
  const sig = std(returns)

  const recent = returns.slice(Math.max(0, nr - 20))
  const recentVol = std(recent)
  if (sig > 1e-9 && recentVol > sig * 3) {
    return {
      agentId: id,
      vote: "VETO",
      confidence: 0.9,
      activity,
      reasoning: `VOLATILITY CRISIS: recent_vol=${recentVol.toFixed(4)} > 3x hist_vol=${(sig * 3).toFixed(4)}`,
      metrics: { recentVol, histVol: sig },
      flags: ["VOLATILITY_CRISIS"],
    }
  }

  const drift = mu - 0.5 * sig * sig
  const sims = 1000
  const horizon = 24
  const finals: number[] = new Array(sims)
  for (let s = 0; s < sims; s++) {
    let p = price
    for (let h = 0; h < horizon; h++) {
      const u1 = Math.random() || 1e-12
      const u2 = Math.random()
      const zr = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      p *= Math.exp(drift + sig * zr)
    }
    finals[s] = p
  }
  finals.sort((a, b) => a - b)
  const p5 = percentile(finals, 5)
  const p50 = percentile(finals, 50)
  const p95 = percentile(finals, 95)
  // Share of simulated paths that finish above current price.
  const upShare = finals.filter((p) => p > price).length / sims

  const score = (upShare - 0.5) * 2
  const { vote, confidence } = voteFromScore(score, 0.12)

  return {
    agentId: id,
    vote,
    confidence: clamp(confidence, 0, 0.95),
    activity,
    reasoning: `GBM P5=${p5.toFixed(2)} P50=${p50.toFixed(2)} P95=${p95.toFixed(2)} up_share=${(upShare * 100).toFixed(0)}% mu=${mu.toFixed(5)}`,
    metrics: { p5, p50, p95, upShare, mu, sigma: sig },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CRYPTOGRAPHER — Volume Profile (POC) + CVD + whale footprint + patterns
// ═══════════════════════════════════════════════════════════════════════════════
async function cryptographer(input: AgentInput): Promise<AgentOutput> {
  const id = "cryptographer"
  const activity = "Decoding volume profile (POC), cumulative delta & candle patterns"
  const candles = input.candles
  const n = candles.length
  if (n < 30) return weakWait(id, "insufficient candles", activity)

  const minP = Math.min(...candles.map((c) => c.low))
  const maxP = Math.max(...candles.map((c) => c.high))
  const bins = 50
  const binW = (maxP - minP) / bins
  let poc = input.price
  if (binW >= 1e-10) {
    const hist = new Array(bins).fill(0)
    for (const c of candles) {
      const idx = Math.min(bins - 1, Math.floor((c.close - minP) / binW))
      hist[idx] += c.vol
    }
    let maxIdx = 0
    for (let i = 1; i < bins; i++) if (hist[i] > hist[maxIdx]) maxIdx = i
    poc = minP + (maxIdx + 0.5) * binW
  }

  const window = 20
  const recent = candles.slice(Math.max(0, n - window))
  const cvd = recent.reduce((acc, c) => acc + (c.close > c.open ? c.vol : c.close < c.open ? -c.vol : 0), 0)

  const vols = input.volumes
  const lastVol = vols[vols.length - 1] ?? 0
  const histVol = vols.slice(0, Math.max(0, vols.length - 1))
  const mV = mean(histVol)
  const sV = std(histVol)
  const volZ = sV > 1e-10 ? (lastVol - mV) / sV : 0
  const whalePresent = volZ > 2.5
  const lastC = candles[n - 1]
  const whaleDir = whalePresent ? (lastC.close > lastC.open ? 1 : -1) : 0

  const prev = candles[n - 2]
  const rangeL = lastC.high - lastC.low
  const bodyL = Math.abs(lastC.close - lastC.open)
  const bodyRatio = rangeL > 1e-10 ? bodyL / rangeL : 0
  const bullEngulf = lastC.close > lastC.open && lastC.open < prev.close && lastC.close > prev.open && prev.close < prev.open
  const bearEngulf = lastC.close < lastC.open && lastC.open > prev.close && lastC.close < prev.open && prev.close > prev.open
  const isDoji = bodyRatio < 0.1

  let score = 0
  if (bullEngulf) { score += 0.35; if (cvd > 0) score += 0.15 }
  if (bearEngulf) { score -= 0.35; if (cvd < 0) score -= 0.15 }
  if (isDoji) score *= 0.5
  const cvdNorm = mV > 1e-10 ? cvd / (mV * window) : 0
  score += clamp(cvdNorm, -0.35, 0.35)
  if (whalePresent) {
    score *= 1 + Math.min(0.5, volZ / 5)
    if (whaleDir < 0) score = Math.min(score, -Math.abs(score))
    if (whaleDir > 0) score = Math.max(score, Math.abs(score))
  }
  const pocDist = Math.abs((input.price - poc) / Math.max(1, poc))
  if (pocDist < 0.005) score *= 1.1
  score = clamp(score, -1, 1)

  const pattern = bullEngulf ? "BullEngulf" : bearEngulf ? "BearEngulf" : isDoji ? "Doji" : "None"
  const { vote, confidence } = voteFromScore(score, 0.15)

  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `Pattern=${pattern} CVD=${cvd.toFixed(0)} whaleZ=${volZ.toFixed(1)} POC=${poc.toFixed(2)} score=${score.toFixed(2)}`,
    metrics: { poc, cvd, volZ, whaleDir, score },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LINGUIST — Tape reader: volume-weighted buy/sell pressure (order-flow sentiment)
// ═══════════════════════════════════════════════════════════════════════════════
async function linguist(input: AgentInput): Promise<AgentOutput> {
  const id = "linguist"
  const activity = "Reading the tape — volume-weighted buy/sell pressure over recent candles"
  const candles = input.candles
  const n = candles.length
  if (n < 10) return weakWait(id, "insufficient candles", activity)

  const window = Math.min(24, n)
  const recent = candles.slice(n - window)
  let pressure = 0
  let volSum = 0
  for (const c of recent) {
    const range = c.high - c.low
    const body = c.close - c.open
    const bodyRatio = range > 1e-9 ? body / range : 0 // -1..1 conviction
    pressure += bodyRatio * c.vol
    volSum += c.vol
  }
  const tape = volSum > 1e-9 ? pressure / volSum : 0 // -1..1

  // Confirm with where price sits in the recent range (acceptance).
  const hi = Math.max(...recent.map((c) => c.high))
  const lo = Math.min(...recent.map((c) => c.low))
  const loc = hi - lo > 1e-9 ? ((input.price - lo) / (hi - lo)) * 2 - 1 : 0

  const score = clamp(tape * 0.7 + loc * 0.3, -1, 1)
  const { vote, confidence } = voteFromScore(score, 0.12)

  const label = score > 0.3 ? "BULLISH_TAPE" : score < -0.3 ? "BEARISH_TAPE" : "MIXED_TAPE"
  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `${label}: tape_pressure=${tape.toFixed(2)} range_loc=${loc.toFixed(2)} score=${score.toFixed(2)}`,
    metrics: { tape, rangeLoc: loc, score },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. LIQUIDATOR — liquidation cluster magnet (OHLCV + OI + LSR)
// ═══════════════════════════════════════════════════════════════════════════════
const LEV_TIERS = [2, 5, 10, 20, 25, 50, 100]
const LEV_WEIGHTS = [0.04, 0.12, 0.3, 0.28, 0.12, 0.09, 0.05]
const MMR = 0.004
async function liquidator(input: AgentInput): Promise<AgentOutput> {
  const id = "liquidator"
  const activity = "Mapping liquidation clusters (leverage ladder vs OI & long/short ratio)"
  const candles = input.candles
  const n = candles.length
  const atr = wilderAtr(input.highs, input.lows, input.closes, 14)
  const current = input.price

  // Fallback: if OI/volume is unavailable, derive a directional read from where
  // price sits relative to its recent swing (liquidity tends to pool at extremes).
  const volTotal = input.volumes.reduce((a, b) => a + b, 0)
  if (n < 20 || input.openInterest < 1 || volTotal < 1) {
    const hi = Math.max(...input.highs.slice(-50))
    const lo = Math.min(...input.lows.slice(-50))
    const loc = hi - lo > 1e-9 ? (current - lo) / (hi - lo) : 0.5
    // Price near range lows → short liquidity below likely swept → mild LONG, and vice-versa.
    const score = (0.5 - loc) * 1.2
    const { vote, confidence } = voteFromScore(clamp(score, -1, 1), 0.15)
    return {
      agentId: id,
      vote,
      confidence,
      activity,
      reasoning: `OI feed thin — using swing liquidity proxy (range_loc=${loc.toFixed(2)})`,
      metrics: { atr, rangeLoc: loc },
    }
  }

  const oiUsd = input.openInterest * current
  const lsr = Math.max(1e-6, input.lsr)
  const longFrac = lsr / (1 + lsr)
  const shortFrac = 1 - longFrac

  const longLiq: [number, number][] = []
  const shortLiq: [number, number][] = []
  candles.forEach((candle, i) => {
    const vwap = (candle.high + candle.low + candle.close) / 3
    const volW = (input.volumes[i] ?? 0) / volTotal
    const oiCan = oiUsd * volW
    LEV_TIERS.forEach((lev, j) => {
      const weight = oiCan * LEV_WEIGHTS[j]
      longLiq.push([vwap * (1 - 1 / lev + MMR), weight * longFrac])
      shortLiq.push([vwap * (1 + 1 / lev - MMR), weight * shortFrac])
    })
  })

  const above = shortLiq.filter(([p]) => p > current && p - current < atr * 2).sort((a, b) => a[0] - b[0])[0]
  const below = longLiq.filter(([p]) => p < current && current - p < atr * 2).sort((a, b) => b[0] - a[0])[0]

  let score = 0
  let detail = "no cluster within ATRx2"
  if (above && below) {
    const dAbove = above[0] - current
    const dBelow = current - below[0]
    const scoreA = Math.min(1, above[1] / oiUsd) / Math.max(1e-8, dAbove)
    const scoreB = Math.min(1, below[1] / oiUsd) / Math.max(1e-8, dBelow)
    score = clamp((scoreA - scoreB) / Math.max(scoreA, scoreB, 1e-8), -1, 1)
    detail = score > 0 ? `SHORT cluster magnet above @ ${above[0].toFixed(2)}` : `LONG cluster magnet below @ ${below[0].toFixed(2)}`
  } else if (above) {
    score = Math.min(1, above[1] / oiUsd); detail = `SHORT cluster above @ ${above[0].toFixed(2)}`
  } else if (below) {
    score = -Math.min(1, below[1] / oiUsd); detail = `LONG cluster below @ ${below[0].toFixed(2)}`
  }
  const { vote, confidence } = voteFromScore(score, 0.12)
  return { agentId: id, vote, confidence, activity, reasoning: detail, metrics: { atr, oiUsd, score } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ABSURDIST — crowd contrarian: funding + open-interest build-up vs price
// ═══════════════════════════════════════════════════════════════════════════════
async function absurdist(input: AgentInput): Promise<AgentOutput> {
  const id = "absurdist"
  const activity = "Hunting crowded trades — funding extremes & leverage build-up (squeeze risk)"
  const c = input.closes
  if (c.length < 10) return weakWait(id, "insufficient candles", activity)

  const fr = input.fundingRate
  // Crowded longs (very positive funding) → fade to SHORT; crowded shorts → fade LONG.
  const fundingTilt = -tanh(fr * 800) // fr ~0.0005 -> ~ -0.38
  // Long/short crowd extremes.
  const lsr = Math.max(1e-6, input.lsr)
  const crowdTilt = -tanh((lsr - 1) * 1.5)
  // But never fight a strong impulse — temper contrarian when momentum is strong.
  const er = efficiencyRatio(c, 14)
  const last = c[c.length - 1]
  const ref = c[Math.max(0, c.length - 15)]
  const momentumSign = last >= ref ? 1 : -1
  const trendDamp = er > 0.45 ? 0.4 : 1

  const score = clamp((fundingTilt * 0.6 + crowdTilt * 0.4) * trendDamp, -1, 1)
  // If the contrarian read directly opposes a very strong trend, soften it further.
  const aligned = Math.sign(score) === momentumSign
  const finalScore = aligned ? score : score * (er > 0.5 ? 0.5 : 1)
  const { vote, confidence } = voteFromScore(finalScore, 0.12)

  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `funding=${fr.toFixed(5)} LSR=${lsr.toFixed(2)} fundTilt=${fundingTilt.toFixed(2)} crowdTilt=${crowdTilt.toFixed(2)} score=${finalScore.toFixed(2)}`,
    metrics: { funding: fr, lsr, fundingTilt, crowdTilt, score: finalScore },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. GAME THEORIST — order book imbalance (bid/ask depth)
// ═══════════════════════════════════════════════════════════════════════════════
async function gameTheorist(input: AgentInput): Promise<AgentOutput> {
  const id = "game_theorist"
  const activity = "Order-book game theory — top-of-book bid/ask imbalance"
  const bid = input.bid
  const ask = input.ask
  const total = bid + ask
  if (total < 1e-9) {
    // No book depth → fall back to last-candle aggressor (close vs midpoint).
    const lc = input.candles[input.candles.length - 1]
    const score = lc ? clamp((lc.close - (lc.high + lc.low) / 2) / Math.max(1e-9, (lc.high - lc.low) / 2), -1, 1) : 0
    const { vote, confidence } = voteFromScore(score, 0.2)
    return { agentId: id, vote, confidence: confidence * 0.6, activity, reasoning: `No book depth — aggressor proxy score=${score.toFixed(2)}`, metrics: { score } }
  }
  const obi = (bid - ask) / total
  const { vote, confidence } = voteFromScore(obi, 0.1)
  return { agentId: id, vote, confidence, activity, reasoning: `OBI=${obi.toFixed(3)} (bid ${bid.toFixed(1)} / ask ${ask.toFixed(1)})`, metrics: { obi, bid, ask } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. ECONOMIST — carry & flow: funding carry + OI-weighted drift
// ═══════════════════════════════════════════════════════════════════════════════
async function economist(input: AgentInput): Promise<AgentOutput> {
  const id = "economist"
  const activity = "Macro carry & flow — funding regime vs realised price drift"
  const c = input.closes
  if (c.length < 12) return weakWait(id, "insufficient candles", activity)

  const fr = input.fundingRate
  const rets = logReturns(c.slice(-24))
  const drift = mean(rets)
  const driftScore = tanh(drift * 400) // realised trend
  // Modest funding carry: persistent positive funding slightly favours continuation
  // until it gets extreme (handled by absurdist). Here funding is a confirmation tilt.
  const fundingScore = tanh(fr * 300) * 0.5

  const score = clamp(driftScore * 0.7 + fundingScore * 0.3, -1, 1)
  const { vote, confidence } = voteFromScore(score, 0.12)
  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `drift=${drift.toFixed(4)} funding=${fr.toFixed(5)} OI=${input.openInterest.toFixed(0)} score=${score.toFixed(2)}`,
    metrics: { drift, funding: fr, score },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. DATA ENGINEER — dual-role: data-integrity gatekeeper + volume-confirmed read.
//    First it VETOs bad data (gaps, flatlines, spikes). Once the dataset is clean
//    it ACTIVELY analyses it — casting a real directional vote from a volume-backed
//    trend confirmation, scaled by the measured data quality. No more idle WAIT.
// ═══════════════════════════════════════════════════════════════════════════════
async function dataEngineer(input: AgentInput): Promise<AgentOutput> {
  const id = "data_engineer"
  const activity = "Validating data integrity, then confirming the volume-backed trend"
  const candles = input.candles
  if (candles.length === 0) return blockingVeto(id, "Missing candles data", activity)
  if (input.price <= 0) return blockingVeto(id, "Invalid price (<= 0.0)", activity)
  if (candles.length >= 5) {
    const last = candles.length - 1
    let allSame = true
    for (let i = last - 4; i <= last; i++) {
      if (Math.abs(candles[i].close - input.price) > 1e-8) { allSame = false; break }
    }
    if (allSame) return blockingVeto(id, "Stale data: flatline in last 5 candles", activity)
  }
  const lc = candles[candles.length - 1]
  if (lc.open > 0) {
    const spikePct = Math.abs(lc.close - lc.open) / lc.open
    if (spikePct > 0.15) return blockingVeto(id, "Data spike anomaly (>15% in single candle)", activity)
  }

  // ── Data passed integrity checks → ACTIVELY analyse the validated dataset ──
  const c = input.closes
  if (c.length < 21) {
    return { agentId: id, vote: "WAIT", confidence: 0, activity, reasoning: "Data sanitised & validated — clear to trade (insufficient history for a directional read)", metrics: { dataQuality: 1 } }
  }

  // Data-quality score: volume completeness + finite-close completeness.
  const vols = input.volumes
  const nonZeroVol = vols.filter((v) => v > 0).length
  const volCompleteness = vols.length > 0 ? nonZeroVol / vols.length : 0
  const finiteCloses = c.filter((x) => Number.isFinite(x) && x > 0).length
  const closeCompleteness = c.length > 0 ? finiteCloses / c.length : 0
  const dataQuality = clamp(0.5 * volCompleteness + 0.5 * closeCompleteness, 0, 1)

  // Volume-confirmed momentum: fast vs slow SMA spread, gated by trend efficiency
  // and confirmed by whether recent participation (volume) is supporting the move.
  const fast = sma(c, 9)
  const slow = sma(c, 21)
  const trendSpread = slow > 1e-9 ? (fast - slow) / slow : 0
  const recentVol = mean(vols.slice(-5))
  const baseVol = mean(vols.slice(0, Math.max(1, vols.length - 5)))
  const volSupport = baseVol > 1e-9 ? clamp(recentVol / baseVol, 0.5, 2) : 1
  const er = efficiencyRatio(c, 14)

  const score = clamp(tanh(trendSpread * 40) * (0.4 + 0.3 * er) * (volSupport / 1.5) * dataQuality, -1, 1)
  const { vote, confidence } = voteFromScore(score, 0.12)

  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `Data OK (quality ${(dataQuality * 100).toFixed(0)}%) — vol-confirmed trend spread=${(trendSpread * 100).toFixed(2)}% ER=${er.toFixed(2)} volSupport=${volSupport.toFixed(2)} score=${score.toFixed(2)}`,
    metrics: { dataQuality, trendSpread, er, volSupport, score },
  }
}

function blockingVeto(id: string, reason: string, activity: string): AgentOutput {
  return { agentId: id, vote: "VETO", confidence: 1, activity, reasoning: `Blocking execution: ${reason}`, metrics: {}, flags: ["DATA_BLOCK"] }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. DATA SCIENTIST — linear-regression forecast (trend slope + fit quality)
// ═══════════════════════════════════════════════════════════════════════════════
async function dataScientist(input: AgentInput): Promise<AgentOutput> {
  const id = "data_scientist"
  const activity = "Fitting least-squares regression channel & projecting next-bar drift"
  const c = input.closes
  if (c.length < 20) return weakWait(id, "insufficient candles", activity)

  const window = Math.min(30, c.length)
  const slice = c.slice(c.length - window)
  const { slope, r2 } = linreg(slice)
  const px = mean(slice)
  // Normalise slope to a per-bar % move, scale conviction by fit quality (R²).
  const slopePct = px > 1e-9 ? (slope / px) * 100 : 0
  const score = clamp(tanh(slopePct * 6) * (0.4 + 0.6 * r2), -1, 1)
  const { vote, confidence } = voteFromScore(score, 0.12)

  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `slope=${slopePct.toFixed(3)}%/bar R²=${r2.toFixed(2)} score=${score.toFixed(2)}`,
    metrics: { slopePct, r2, score },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. STATISTICIAN — mean reversion: z-score extension + crowd positioning
// ═══════════════════════════════════════════════════════════════════════════════
async function statistician(input: AgentInput): Promise<AgentOutput> {
  const id = "statistician"
  const activity = "Mean-reversion stats — z-score extension & long/short positioning"
  const c = input.closes
  if (c.length < 20) return weakWait(id, "insufficient candles", activity)

  const z = zscore(c, 20)
  // Fade extension toward the mean.
  const revertScore = clamp(-tanh(z * 0.8), -1, 1)
  // Positioning tilt: crowded longs (lsr>1) lean SHORT.
  const lsr = Math.max(1e-6, input.lsr)
  const posTilt = -tanh((lsr - 1) * 1.2) * 0.4

  const score = clamp(revertScore * 0.75 + posTilt * 0.25, -1, 1)
  const { vote, confidence } = voteFromScore(score, 0.15)
  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `Z=${z.toFixed(2)} (revert ${revertScore.toFixed(2)}) LSR=${lsr.toFixed(2)} score=${score.toFixed(2)}`,
    metrics: { z, lsr, score },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 12. PSYCHOLOGIST — fear/greed from candle wicks (rejection) & volatility
// ═══════════════════════════════════════════════════════════════════════════════
async function psychologist(input: AgentInput): Promise<AgentOutput> {
  const id = "psychologist"
  const activity = "Reading crowd fear/greed via wick rejection & volatility expansion"
  const candles = input.candles
  const n = candles.length
  if (n < 10) return weakWait(id, "insufficient candles", activity)

  const window = Math.min(12, n)
  const recent = candles.slice(n - window)
  let wickBias = 0
  let wsum = 0
  for (const c of recent) {
    const top = c.high - Math.max(c.open, c.close) // upper wick = rejection of highs
    const bot = Math.min(c.open, c.close) - c.low   // lower wick = rejection of lows
    const range = c.high - c.low
    if (range > 1e-9) {
      // lower wick dominance → buyers defend (bullish); upper wick → sellers (bearish).
      wickBias += ((bot - top) / range) * c.vol
      wsum += c.vol
    }
  }
  const bias = wsum > 1e-9 ? wickBias / wsum : 0

  // Volatility expansion amplifies emotion (conviction), not direction.
  const rets = logReturns(c2(recent))
  const volNow = std(rets.slice(-5))
  const volBase = std(rets)
  const expansion = volBase > 1e-9 ? clamp(volNow / volBase, 0.5, 2) : 1

  const score = clamp(tanh(bias * 2.5) * (0.6 + 0.2 * expansion), -1, 1)
  const { vote, confidence } = voteFromScore(score, 0.12)
  const mood = score > 0.3 ? "ACCUMULATION" : score < -0.3 ? "DISTRIBUTION" : "INDECISION"
  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `${mood}: wick_bias=${bias.toFixed(2)} vol_expansion=${expansion.toFixed(2)} score=${score.toFixed(2)}`,
    metrics: { wickBias: bias, expansion, score },
  }
}

function c2(candles: AgentInput["candles"]): number[] {
  return candles.map((c) => c.close)
}

// ═══════════════════════════════════════════════════════════════════════════════
// 13. ASTROPHYSICIST — momentum "gravity": open-interest mass × price momentum
// ═══════════════════════════════════════════════════════════════════════════════
async function astrophysicist(input: AgentInput): Promise<AgentOutput> {
  const id = "astrophysicist"
  const activity = "Modelling momentum gravity — open-interest mass behind price drift"
  const c = input.closes
  if (c.length < 20) return weakWait(id, "insufficient candles", activity)

  const ref = sma(c, 20)
  const priceMom = ref > 1e-9 ? (input.price - ref) / ref : 0 // % above/below mean
  // OI acts as "mass": more open interest ⇒ stronger conviction behind the move.
  const oiUsd = input.openInterest * input.price
  const massFactor = clamp(Math.log10(Math.max(10, oiUsd)) / 10, 0.4, 1)

  const score = clamp(tanh(priceMom * 25) * massFactor, -1, 1)
  const { vote, confidence } = voteFromScore(score, 0.12)
  return {
    agentId: id,
    vote,
    confidence,
    activity,
    reasoning: `price_mom=${(priceMom * 100).toFixed(2)}% OI_mass=${massFactor.toFixed(2)} score=${score.toFixed(2)}`,
    metrics: { priceMom, massFactor, score },
  }
}

// A "soft" wait used only when there is genuinely not enough data yet. Carries the
// activity string so the UI still shows what the agent would be doing.
function weakWait(agentId: string, reasoning: string, activity: string): AgentOutput {
  return { agentId, vote: "WAIT", confidence: 0, activity, reasoning, metrics: {} }
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUILDER MAP — config id → implementation. Add new agents here.
// ═══════════════════════════════════════════════════════════════════════════════
const AGENT_BUILDERS: Record<string, IAgent["analyze"]> = {
  mathematician,
  physicist,
  cryptographer,
  linguist,
  liquidator,
  absurdist,
  game_theorist: gameTheorist,
  economist,
  data_engineer: dataEngineer,
  data_scientist: dataScientist,
  statistician,
  psychologist,
  astrophysicist,
}

// ═══════════════════════════════════════════════════════════════════════════════
// REGISTER — driven entirely by config.ts enable flags
// ═══════════════════════════════════════════════════════════════════════════════
export function registerBuiltinAgents(): void {
  for (const cfg of AGENT_TEAM_CONFIG) {
    if (!cfg.enabled) {
      console.log(`[AgentRegistry] Skipping disabled agent: ${cfg.id}`)
      continue
    }
    const analyze = AGENT_BUILDERS[cfg.id]
    if (!analyze) {
      console.warn(`[AgentRegistry] No implementation for configured agent '${cfg.id}' — skipping`)
      continue
    }
    agentRegistry.register(
      createAgent({
        id: cfg.id,
        name: cfg.name,
        category: cfg.category,
        weight: cfg.weight,
        enabled: cfg.enabled,
        analyze,
      }),
    )
  }
  console.log(`[AgentRegistry] Registered ${agentRegistry.getEnabledAgents().length} enabled agents`)
}
