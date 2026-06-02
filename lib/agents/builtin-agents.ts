// ────────────────────────────────────────────────────────────────────────────────
// Built-in Analysis Agents — faithful TypeScript port of the 13 Rust quant agents
// (rust-brain/src/agents/*). Each agent is self-contained; the roster + weights +
// enable flags live in `config.ts`. Adding a new agent = add a config entry + a
// builder in AGENT_BUILDERS. No other architecture change required.
// ────────────────────────────────────────────────────────────────────────────────

import { createAgent, agentRegistry } from "./registry"
import { AGENT_TEAM_CONFIG } from "./config"
import type { AgentInput, AgentOutput, AgentVote, IAgent } from "./types"

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED MATH (ports of rust-brain/src/agents/mod.rs helpers)
// ═══════════════════════════════════════════════════════════════════════════════

function sma(values: number[], period: number): number {
  if (values.length === 0) return 0
  const n = Math.min(period, values.length)
  const slice = values.slice(values.length - n)
  return slice.reduce((a, b) => a + b, 0) / n
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50
  const deltas: number[] = []
  for (let i = 1; i < closes.length; i++) deltas.push(closes[i] - closes[i - 1])
  const seed = deltas.slice(0, period)
  let avgUp = seed.filter((d) => d >= 0).reduce((a, b) => a + b, 0) / period
  let avgDown = seed.filter((d) => d < 0).reduce((a, b) => a - b, 0) / period
  for (const d of deltas.slice(period)) {
    const up = d > 0 ? d : 0
    const down = d < 0 ? -d : 0
    avgUp = (avgUp * (period - 1) + up) / period
    avgDown = (avgDown * (period - 1) + down) / period
  }
  if (avgDown < 1e-10) return 100
  return 100 - 100 / (1 + avgUp / avgDown)
}

function zscore(series: number[], window: number): number {
  if (series.length < window) return 0
  const w = series.slice(series.length - window)
  const mean = w.reduce((a, b) => a + b, 0) / window
  const variance = w.reduce((a, b) => a + (b - mean) ** 2, 0) / window
  const std = Math.sqrt(variance)
  if (std < 1e-10) return 0
  return (series[series.length - 1] - mean) / std
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

function calcEma(closes: number[], period: number): number {
  if (closes.length === 0) return 0
  if (closes.length < period) return closes.reduce((a, b) => a + b, 0) / closes.length
  const k = 2 / (period + 1)
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (const c of closes.slice(period)) ema = c * k + ema * (1 - k)
  return ema
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.round((p / 100) * (sorted.length - 1))
  return sorted[Math.min(idx, sorted.length - 1)]
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function wait(agentId: string, reasoning: string, metrics: Record<string, number> = {}): AgentOutput {
  return { agentId, vote: "WAIT", confidence: 0, reasoning, metrics }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. MATHEMATICIAN — Bayesian probability chain (RSI + Z-score), emits noise/anomaly
// ═══════════════════════════════════════════════════════════════════════════════
async function mathematician(input: AgentInput): Promise<AgentOutput> {
  const id = "mathematician"
  const c = input.closes
  const period = 14
  if (c.length < period * 2) return wait(id, "insufficient candles")

  // Kaufman Efficiency Ratio regime filter
  let er = 0
  const n = Math.min(period, c.length - 1)
  if (n > 0) {
    const change = Math.abs(c[c.length - 1] - c[c.length - 1 - n])
    let vol = 0
    for (let i = c.length - n; i < c.length; i++) vol += Math.abs(c[i] - c[i - 1])
    if (vol > 1e-9) er = change / vol
  }
  const strongUp = er > 0.35 && c[c.length - 1] > c[c.length - 1 - n]
  const strongDown = er > 0.35 && c[c.length - 1] < c[c.length - 1 - n]

  const rsiVal = rsi(c, period)
  let probUp = 0.5
  if (strongUp) {
    if (rsiVal > 65) probUp = bayesianUpdate(probUp, 0.75, 0.25)
    else if (rsiVal < 50) probUp = bayesianUpdate(probUp, 0.65, 0.35)
  } else if (strongDown) {
    if (rsiVal < 35) probUp = bayesianUpdate(probUp, 0.25, 0.75)
    else if (rsiVal > 50) probUp = bayesianUpdate(probUp, 0.35, 0.65)
  } else {
    if (rsiVal < 30) probUp = bayesianUpdate(probUp, 0.72, 0.28)
    else if (rsiVal < 45) probUp = bayesianUpdate(probUp, 0.57, 0.43)
    else if (rsiVal > 70) probUp = bayesianUpdate(probUp, 0.28, 0.72)
    else if (rsiVal > 55) probUp = bayesianUpdate(probUp, 0.43, 0.57)
  }

  const z = zscore(c, period)
  if (strongUp) {
    if (z > 1.5) probUp = bayesianUpdate(probUp, 0.65, 0.35)
  } else if (strongDown) {
    if (z < -1.5) probUp = bayesianUpdate(probUp, 0.35, 0.65)
  } else {
    if (z < -2) probUp = bayesianUpdate(probUp, 0.68, 0.32)
    else if (z < -1) probUp = bayesianUpdate(probUp, 0.58, 0.42)
    else if (z > 2) probUp = bayesianUpdate(probUp, 0.32, 0.68)
    else if (z > 1) probUp = bayesianUpdate(probUp, 0.42, 0.58)
  }
  const probDown = 1 - probUp

  const atr = wilderAtr(input.highs, input.lows, c, period)
  const lastCandle = input.candles[input.candles.length - 1]
  const bodyLast = lastCandle ? Math.abs(c[c.length - 1] - lastCandle.open) : 0
  const rangeLast = lastCandle ? lastCandle.high - lastCandle.low : 1
  const noiseRatio = rangeLast > 1e-9 ? (rangeLast - bodyLast) / rangeLast : 0
  const anomaly = Math.abs(z) > 4

  let vote: AgentVote = "WAIT"
  let confidence = 0.5
  if (probUp > 0.62) { vote = "LONG"; confidence = probUp }
  else if (probDown > 0.62) { vote = "SHORT"; confidence = probDown }

  const flags: string[] = []
  if (anomaly) flags.push("anomaly")
  return {
    agentId: id,
    vote,
    confidence,
    reasoning: `RSI=${rsiVal.toFixed(1)} Z=${z.toFixed(2)} P(up)=${probUp.toFixed(3)} noise=${noiseRatio.toFixed(2)} anomaly=${anomaly} ATR=${atr.toFixed(4)}`,
    metrics: { rsi: rsiVal, z, probUp, noise: noiseRatio, anomaly: anomaly ? 1 : 0, atr },
    flags,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. PHYSICIST — GBM Monte Carlo, VETOs on volatility crisis
// ═══════════════════════════════════════════════════════════════════════════════
async function physicist(input: AgentInput): Promise<AgentOutput> {
  const id = "physicist"
  const c = input.closes
  if (c.length < 30) return wait(id, "insufficient candles for GBM")
  const price = input.price

  const returns: number[] = []
  for (let i = 1; i < c.length; i++) returns.push(Math.log(c[i] / c[i - 1]))
  const nr = returns.length
  const mu = returns.reduce((a, b) => a + b, 0) / nr
  const variance = returns.reduce((a, b) => a + (b - mu) ** 2, 0) / nr
  const sig = Math.sqrt(variance)

  const recent = returns.slice(Math.max(0, nr - 20))
  const mRec = recent.reduce((a, b) => a + b, 0) / recent.length
  const recentVol = Math.sqrt(recent.reduce((a, b) => a + (b - mRec) ** 2, 0) / recent.length)
  if (recentVol > sig * 3) {
    return {
      agentId: id,
      vote: "VETO",
      confidence: 0.9,
      reasoning: `VOLATILITY CRISIS: recent_vol=${recentVol.toFixed(4)} > 3x hist_vol=${(sig * 3).toFixed(4)}`,
      metrics: { recentVol, histVol: sig },
      flags: ["VOLATILITY_CRISIS"],
    }
  }

  const drift = mu - 0.5 * sig * sig
  const diff = sig
  const sims = 1000
  const horizon = 24
  const finals: number[] = new Array(sims)
  for (let s = 0; s < sims; s++) {
    let p = price
    for (let h = 0; h < horizon; h++) {
      // Box-Muller standard normal
      const u1 = Math.random() || 1e-12
      const u2 = Math.random()
      const zr = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      p *= Math.exp(drift + diff * zr)
    }
    finals[s] = p
  }
  finals.sort((a, b) => a - b)
  const p5 = percentile(finals, 5)
  const p50 = percentile(finals, 50)
  const p95 = percentile(finals, 95)
  const spread = p95 - p5
  const upsideBias = spread > 1e-8 ? (p95 - price) / spread : 0.5

  let vote: AgentVote = "WAIT"
  let confidence = 0.5
  if (upsideBias > 0.62) { vote = "LONG"; confidence = Math.min(0.95, 0.4 + (upsideBias - 0.5)) }
  else if (upsideBias < 0.38) { vote = "SHORT"; confidence = Math.min(0.95, 0.4 + (0.5 - upsideBias)) }

  return {
    agentId: id,
    vote,
    confidence,
    reasoning: `GBM P5=${p5.toFixed(2)} P50=${p50.toFixed(2)} P95=${p95.toFixed(2)} upside_bias=${upsideBias.toFixed(3)} mu=${mu.toFixed(5)}`,
    metrics: { p5, p50, p95, upsideBias, mu, sigma: sig },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CRYPTOGRAPHER — Volume Profile (POC) + CVD + whale footprint + patterns
// ═══════════════════════════════════════════════════════════════════════════════
async function cryptographer(input: AgentInput): Promise<AgentOutput> {
  const id = "cryptographer"
  const candles = input.candles
  const n = candles.length
  if (n < 50) return wait(id, "insufficient candles")

  // POC
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

  // CVD
  const window = 20
  const recent = candles.slice(Math.max(0, n - window))
  const cvd = recent.reduce((acc, c) => acc + (c.close > c.open ? c.vol : c.close < c.open ? -c.vol : 0), 0)

  // Whale footprint
  const vols = input.volumes
  const lastVol = vols[vols.length - 1] ?? 0
  const histVol = vols.slice(0, Math.max(0, vols.length - 1))
  const meanVol = histVol.length ? histVol.reduce((a, b) => a + b, 0) / histVol.length : 0
  const stdVol = histVol.length ? Math.sqrt(histVol.reduce((a, b) => a + (b - meanVol) ** 2, 0) / histVol.length) : 0
  const volZ = stdVol > 1e-10 ? (lastVol - meanVol) / stdVol : 0
  const whalePresent = volZ > 2.5
  const lastC = candles[n - 1]
  const whaleDir = whalePresent ? (lastC.close > lastC.open ? 1 : -1) : 0

  // Patterns
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
  const cvdNorm = meanVol > 1e-10 ? cvd / (meanVol * window) : 0
  score += clamp(cvdNorm, -0.3, 0.3)
  if (whalePresent) {
    score *= 1 + Math.min(0.5, volZ / 5)
    if (whaleDir < 0) score = Math.min(score, -Math.abs(score))
    if (whaleDir > 0) score = Math.max(score, Math.abs(score))
  }
  const pocDist = Math.abs((input.price - poc) / Math.max(1, poc))
  if (pocDist < 0.005) score *= 1.1
  score = clamp(score, -1, 1)

  const pattern = bullEngulf ? "BullishEngulfing" : bearEngulf ? "BearishEngulfing" : isDoji ? "Doji" : "None"
  let vote: AgentVote = "WAIT"
  let confidence = 0.5
  if (score > 0.25) { vote = "LONG"; confidence = Math.abs(score) }
  else if (score < -0.25) { vote = "SHORT"; confidence = Math.abs(score) }

  return {
    agentId: id,
    vote,
    confidence,
    reasoning: `Pattern=${pattern} CVD=${cvd.toFixed(0)} WhalZ=${volZ.toFixed(1)} POC=${poc.toFixed(2)} score=${score.toFixed(3)}`,
    metrics: { poc, cvd, volZ, whaleDir, score },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. LINGUIST — social sentiment (reads cached sentiment + news count)
// ═══════════════════════════════════════════════════════════════════════════════
async function linguist(input: AgentInput): Promise<AgentOutput> {
  const id = "linguist"
  const score = input.sentimentScore
  const count = input.newsCount
  if (count === 0) return wait(id, "no news data in cache yet")
  const baseConf = Math.min(1, count / 10)
  let vote: AgentVote = "WAIT"
  let confidence = baseConf * 0.3
  let label = "NEUTRAL"
  if (score > 0.4) { label = "VERY_BULLISH"; vote = "LONG"; confidence = baseConf }
  else if (score > 0.1) { label = "BULLISH"; vote = "LONG"; confidence = baseConf * 0.75 }
  else if (score < -0.4) { label = "VERY_BEARISH"; vote = "SHORT"; confidence = baseConf }
  else if (score < -0.1) { label = "BEARISH"; vote = "SHORT"; confidence = baseConf * 0.75 }
  return {
    agentId: id,
    vote,
    confidence,
    reasoning: `sentiment=${score.toFixed(3)} label=${label} articles=${count}`,
    metrics: { sentiment: score, newsCount: count },
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
  const candles = input.candles
  const n = candles.length
  if (n < 20 || input.openInterest < 1) return wait(id, "insufficient data for liq estimation")
  const atr = wilderAtr(input.highs, input.lows, input.closes, 14)
  const current = input.price
  const oiUsd = input.openInterest * current
  const lsr = Math.max(1e-6, input.lsr)
  const longFrac = lsr / (1 + lsr)
  const shortFrac = 1 - longFrac
  const volTotal = input.volumes.reduce((a, b) => a + b, 0)
  if (volTotal < 1) return wait(id, "zero volume")

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

  const above = shortLiq
    .filter(([p]) => p > current && p - current < atr * 2)
    .sort((a, b) => a[0] - current - (b[0] - current))[0]
  const below = longLiq
    .filter(([p]) => p < current && current - p < atr * 2)
    .sort((a, b) => current - a[0] - (current - b[0]))[0]

  let vote: AgentVote = "WAIT"
  let confidence = 0
  let detail = "no cluster in ATR x2 radius"
  if (above && below) {
    const dAbove = above[0] - current
    const dBelow = current - below[0]
    const densAbove = Math.min(1, above[1] / oiUsd)
    const densBelow = Math.min(1, below[1] / oiUsd)
    const scoreA = densAbove / Math.max(1e-8, dAbove)
    const scoreB = densBelow / Math.max(1e-8, dBelow)
    if (scoreA > scoreB * 1.2) { vote = "LONG"; confidence = densAbove; detail = `SHORT cluster above @ ${above[0].toFixed(2)}` }
    else if (scoreB > scoreA * 1.2) { vote = "SHORT"; confidence = densBelow; detail = `LONG cluster below @ ${below[0].toFixed(2)}` }
    else detail = "clusters balanced"
  } else if (above) {
    vote = "LONG"; confidence = Math.min(1, above[1] / oiUsd); detail = `SHORT cluster above @ ${above[0].toFixed(2)}`
  } else if (below) {
    vote = "SHORT"; confidence = Math.min(1, below[1] / oiUsd); detail = `LONG cluster below @ ${below[0].toFixed(2)}`
  }
  return { agentId: id, vote, confidence, reasoning: detail, metrics: { atr, oiUsd } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ABSURDIST — liq magnet + tether + squeeze + whale inflow + kimchi premium
// ═══════════════════════════════════════════════════════════════════════════════
async function absurdist(input: AgentInput): Promise<AgentOutput> {
  const id = "absurdist"
  const signals: [string, number, number][] = []

  const totalLiq = input.longLiq1h + input.shortLiq1h
  let liqScore = 0
  if (totalLiq > 1) {
    const shortDom = input.shortLiq1h / totalLiq
    const longDom = input.longLiq1h / totalLiq
    if (shortDom > 0.6) liqScore = (shortDom - 0.5) * 2
    else if (longDom > 0.6) liqScore = -(longDom - 0.5) * 2
  }
  signals.push(["LiqMagnet", liqScore, 0.3])

  const tetherScore = clamp(input.usdtDeltaPct, -3, 3) / 3
  signals.push(["TetherPrinter", tetherScore, 0.15])

  let squeezeScore = 0
  const fr = input.fundingRate
  if (fr > 0.001) squeezeScore = -Math.min(1, fr * 500)
  else if (fr < -0.001) squeezeScore = Math.min(1, Math.abs(fr) * 500)
  signals.push(["SqueezePred", squeezeScore, 0.25])

  let whaleScore = 0
  const inflow = input.whaleInflowUsd
  if (inflow > 10_000_000) whaleScore = Math.min(1, inflow / 500_000_000)
  else if (inflow < -10_000_000) whaleScore = Math.max(-1, inflow / 500_000_000)
  signals.push(["WhaleInflow", whaleScore, 0.2])

  const kimchiScore = clamp(input.kimchiPct / 5, -1, 1)
  signals.push(["KimchiPrem", kimchiScore, 0.1])

  const totalWeight = signals.reduce((a, [, , w]) => a + w, 0)
  const weighted = signals.reduce((a, [, s, w]) => a + s * w, 0) / totalWeight

  let vote: AgentVote = "WAIT"
  let confidence = 0
  if (weighted > 0.15) { vote = "LONG"; confidence = Math.min(1, weighted) }
  else if (weighted < -0.15) { vote = "SHORT"; confidence = Math.min(1, Math.abs(weighted)) }

  return {
    agentId: id,
    vote,
    confidence,
    reasoning: `score=${weighted.toFixed(3)} liq=${liqScore.toFixed(2)} teth=${tetherScore.toFixed(2)} sqz=${squeezeScore.toFixed(2)} whale=${whaleScore.toFixed(2)} kimchi=${kimchiScore.toFixed(2)}`,
    metrics: { weighted, liqScore, tetherScore, squeezeScore, whaleScore, kimchiScore },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. GAME THEORIST — order book imbalance (bid/ask depth)
// ═══════════════════════════════════════════════════════════════════════════════
async function gameTheorist(input: AgentInput): Promise<AgentOutput> {
  const id = "game_theorist"
  const bid = input.bid
  const ask = input.ask
  const total = bid + ask
  if (total < 1e-9) return wait(id, "zero order book depth")
  const obi = (bid - ask) / total
  let vote: AgentVote = "WAIT"
  let confidence = 0
  if (obi > 0.15) { vote = "LONG"; confidence = Math.min(1, Math.abs(obi)) }
  else if (obi < -0.15) { vote = "SHORT"; confidence = Math.min(1, Math.abs(obi)) }
  return { agentId: id, vote, confidence, reasoning: `OBI=${obi.toFixed(3)} (Bid ${bid.toFixed(1)}, Ask ${ask.toFixed(1)})`, metrics: { obi, bid, ask } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 8. ECONOMIST — funding rate + liquidation bias
// ═══════════════════════════════════════════════════════════════════════════════
async function economist(input: AgentInput): Promise<AgentOutput> {
  const id = "economist"
  const fr = input.fundingRate
  const frScore = clamp(fr * 10_000, -1, 1)
  const totalLiq = input.longLiq1h + input.shortLiq1h
  const liqBias = totalLiq > 1e-5 ? (input.shortLiq1h - input.longLiq1h) / totalLiq : 0
  const bias = -frScore * 0.6 + liqBias * 0.4
  let vote: AgentVote = "WAIT"
  let confidence = Math.min(1, Math.abs(bias))
  if (bias > 0.2) vote = "LONG"
  else if (bias < -0.2) vote = "SHORT"
  else confidence = 0
  return { agentId: id, vote, confidence, reasoning: `FR=${fr.toFixed(5)} OI=${input.openInterest.toFixed(0)} LiqBias=${liqBias.toFixed(2)}`, metrics: { fr, liqBias, bias } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 9. DATA ENGINEER — gatekeeper. Only WAITs / VETOs on bad data (weight 0)
// ═══════════════════════════════════════════════════════════════════════════════
async function dataEngineer(input: AgentInput): Promise<AgentOutput> {
  const id = "data_engineer"
  const candles = input.candles
  if (candles.length === 0) return blockingVeto(id, "Missing candles data")
  if (input.price <= 0) return blockingVeto(id, "Invalid price (<= 0.0)")
  // Stale / flatline
  if (candles.length >= 5) {
    const last = candles.length - 1
    let allSame = true
    for (let i = last - 4; i <= last; i++) {
      if (Math.abs(candles[i].close - input.price) > 1e-8) { allSame = false; break }
    }
    if (allSame) return blockingVeto(id, "Stale data: flatline in last 5 candles")
  }
  // Single-candle spike anomaly
  const lc = candles[candles.length - 1]
  if (lc.open > 0) {
    const pct = Math.abs(lc.close - lc.open) / lc.open
    if (pct > 0.15) return blockingVeto(id, "Data spike anomaly (>15% in single candle)")
  }
  return wait(id, "Data Sanitized & Validated")
}

function blockingVeto(id: string, reason: string): AgentOutput {
  return { agentId: id, vote: "VETO", confidence: 1, reasoning: `Blocking execution: ${reason}`, metrics: {}, flags: ["DATA_BLOCK"] }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 10. DATA SCIENTIST — ML proxy via short-window z-score
// ═══════════════════════════════════════════════════════════════════════════════
async function dataScientist(input: AgentInput): Promise<AgentOutput> {
  const id = "data_scientist"
  const c = input.closes
  if (c.length === 0) return wait(id, "No data")
  const recent = Math.min(10, c.length)
  const slice = c.slice(c.length - recent)
  const mean = slice.reduce((a, b) => a + b, 0) / recent
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / recent)
  const z = std > 0 ? (input.price - mean) / std : 0
  let vote: AgentVote = "WAIT"
  if (z > 2) vote = "SHORT"
  else if (z < -2) vote = "LONG"
  else if (z > 0.5) vote = "LONG"
  else if (z < -0.5) vote = "SHORT"
  const confidence = vote === "WAIT" ? 0 : clamp(Math.abs(z) / 3, 0, 1)
  return { agentId: id, vote, confidence, reasoning: `Z-score=${z.toFixed(2)} (ML proxy)`, metrics: { z } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 11. STATISTICIAN — stat-arb proxy via LSR + funding
// ═══════════════════════════════════════════════════════════════════════════════
async function statistician(input: AgentInput): Promise<AgentOutput> {
  const id = "statistician"
  if (input.candles.length === 0) return wait(id, "No data")
  const lsr = input.lsr
  const funding = input.fundingRate
  let vote: AgentVote = "WAIT"
  let confidence = 0
  if (lsr > 1.2 && funding > 0.0001) { vote = "SHORT"; confidence = 0.7 }
  else if (lsr < 0.8 && funding < -0.0001) { vote = "LONG"; confidence = 0.7 }
  else if (lsr > 1.05) { vote = "LONG"; confidence = 0.3 }
  else if (lsr < 0.95) { vote = "SHORT"; confidence = 0.3 }
  return { agentId: id, vote, confidence, reasoning: `LSR=${lsr.toFixed(2)} Funding=${funding.toFixed(4)}`, metrics: { lsr, funding } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 12. PSYCHOLOGIST — market psychology via sentiment + news volume
// ═══════════════════════════════════════════════════════════════════════════════
async function psychologist(input: AgentInput): Promise<AgentOutput> {
  const id = "psychologist"
  const sentiment = input.sentimentScore
  const newsVol = input.newsCount
  if (newsVol === 0 || Math.abs(sentiment) < 0.1) return wait(id, "Neutral or no sentiment data")
  let confidence = clamp(Math.abs(sentiment), 0, 1)
  const vote: AgentVote = sentiment > 0 ? "LONG" : "SHORT"
  if (newsVol > 10) confidence = clamp(confidence + 0.2, 0, 1)
  return { agentId: id, vote, confidence, reasoning: `Sentiment=${sentiment.toFixed(2)} from ${newsVol} sources`, metrics: { sentiment, newsVol } }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 13. ASTROPHYSICIST — whale "gravity" (inflow relative to OI)
// ═══════════════════════════════════════════════════════════════════════════════
async function astrophysicist(input: AgentInput): Promise<AgentOutput> {
  const id = "astrophysicist"
  if (input.candles.length === 0) return wait(id, "No data")
  const gravity = input.whaleInflowUsd / Math.max(1, input.openInterest)
  let vote: AgentVote = "WAIT"
  if (gravity > 0.01) vote = "LONG"
  else if (gravity < -0.01) vote = "SHORT"
  const confidence = vote === "WAIT" ? 0 : clamp(Math.abs(gravity) * 10, 0, 0.85)
  return { agentId: id, vote, confidence, reasoning: `Whale gravity ${gravity.toFixed(4)}`, metrics: { gravity } }
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
