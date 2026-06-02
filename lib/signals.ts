import type { SignalStatus, TrendState, WhaleBias } from "./types"

// Pure, deterministic technical-analysis helpers.
//
// These run server-side on REAL exchange candles (OKX) so the terminal can show
// genuine, reproducible signals and a consensus verdict even when the local Go
// trading engine is offline (e.g. on Vercel). Nothing here is random or mocked —
// every number is derived from the price/volume series passed in.

export function sma(values: number[], period: number): number {
  if (values.length === 0) return 0
  const n = Math.min(period, values.length)
  const slice = values.slice(values.length - n)
  return slice.reduce((a, b) => a + b, 0) / n
}

// Wilder's RSI over `period` closes. Returns 0..100 (50 when not enough data).
export function rsi(closes: number[], period = 14): number {
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

// Average True Range over `period` bars. Falls back to a close-to-close range.
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const n = Math.min(highs.length, lows.length, closes.length)
  if (n < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    )
    if (Number.isFinite(tr)) trs.push(tr)
  }
  if (trs.length === 0) return 0
  const slice = trs.slice(Math.max(0, trs.length - period))
  return slice.reduce((a, b) => a + b, 0) / slice.length
}

// Rate of change (%) of the last close vs `lookback` bars ago.
export function roc(closes: number[], lookback = 10): number {
  if (closes.length < lookback + 1) return 0
  const past = closes[closes.length - 1 - lookback]
  if (!past) return 0
  return ((closes[closes.length - 1] - past) / past) * 100
}

export interface SignalInput {
  closes: number[]
  highs: number[]
  lows: number[]
  lsr: number
  trend: TrendState
  whale: WhaleBias
}

export interface SignalResult {
  signal: SignalStatus
  confidence: number // 0..1 agreement strength
  reason: string
  rsi: number
  atr: number
  entry: number
  tp: number
  sl: number
}

interface Factor {
  weight: number
  vote: number // -1 bearish, 0 neutral, +1 bullish
  label: string
}

// Combine several independent, real indicators into one verdict. The confidence
// is the net agreement between them, so it only gets high when signals align.
export function computeSignal(input: SignalInput): SignalResult {
  const { closes, highs, lows, trend, whale } = input
  const last = closes[closes.length - 1] || 0
  const fast = sma(closes, 7)
  const slow = sma(closes, 25)
  const r = rsi(closes, 14)
  const a = atr(highs, lows, closes, 14)
  const momentum = roc(closes, 10)

  const factors: Factor[] = []

  // 1. Moving-average cross (trend-following)
  factors.push({
    weight: 0.26,
    vote: fast > slow ? 1 : fast < slow ? -1 : 0,
    label: fast > slow ? "MA cross up" : fast < slow ? "MA cross down" : "MA flat",
  })

  // 2. Price relative to the slow MA
  factors.push({
    weight: 0.14,
    vote: last > slow ? 1 : last < slow ? -1 : 0,
    label: last > slow ? "above MA25" : "below MA25",
  })

  // 3. RSI regime (avoid chasing extremes)
  let rsiVote = 0
  let rsiLabel = "RSI neutral"
  if (r >= 55 && r <= 72) {
    rsiVote = 1
    rsiLabel = `RSI ${r.toFixed(0)} bullish`
  } else if (r <= 45 && r >= 28) {
    rsiVote = -1
    rsiLabel = `RSI ${r.toFixed(0)} bearish`
  } else if (r > 72) {
    rsiVote = -0.5
    rsiLabel = `RSI ${r.toFixed(0)} overbought`
  } else if (r < 28) {
    rsiVote = 0.5
    rsiLabel = `RSI ${r.toFixed(0)} oversold`
  }
  factors.push({ weight: 0.2, vote: rsiVote, label: rsiLabel })

  // 4. Momentum (rate of change)
  factors.push({
    weight: 0.18,
    vote: momentum > 0.3 ? 1 : momentum < -0.3 ? -1 : 0,
    label: `ROC ${momentum >= 0 ? "+" : ""}${momentum.toFixed(2)}%`,
  })

  // 5. Whale / long-short account ratio bias
  factors.push({
    weight: 0.12,
    vote: whale === "LONG_HEAVY" ? 1 : whale === "SHORT_HEAVY" ? -1 : 0,
    label: whale === "LONG_HEAVY" ? "whales long" : whale === "SHORT_HEAVY" ? "whales short" : "whales balanced",
  })

  // 6. Overall trend regime
  factors.push({
    weight: 0.1,
    vote: trend === "BULLISH" ? 1 : trend === "BEARISH" ? -1 : 0,
    label: `${trend.toLowerCase()} regime`,
  })

  const net = factors.reduce((acc, f) => acc + f.weight * f.vote, 0) // ~[-1,1]
  const confidence = Math.min(1, Math.abs(net) * 1.35)

  let signal: SignalStatus = "WAIT"
  if (net > 0.16) signal = "LONG"
  else if (net < -0.16) signal = "SHORT"

  // Targets from ATR — only meaningful when we have a directional call.
  let entry = 0
  let tp = 0
  let sl = 0
  if (signal !== "WAIT" && last > 0) {
    entry = last
    const tpMult = 1.8
    const slMult = 1.1
    const dist = a > 0 ? a : last * 0.012 // fall back to 1.2% band if ATR missing
    if (signal === "LONG") {
      tp = entry + tpMult * dist
      sl = entry - slMult * dist
    } else {
      tp = entry - tpMult * dist
      sl = entry + slMult * dist
    }
  }

  // Human-readable rationale from the strongest aligned factors.
  const dir = signal === "WAIT" ? 0 : signal === "LONG" ? 1 : -1
  const aligned = factors
    .filter((f) => (dir === 0 ? f.vote !== 0 : Math.sign(f.vote) === dir))
    .sort((x, y) => Math.abs(y.weight * y.vote) - Math.abs(x.weight * x.vote))
    .slice(0, 3)
    .map((f) => f.label)

  const reason =
    signal === "WAIT"
      ? `No consensus — mixed signals (${factors.map((f) => f.label).slice(0, 3).join(", ")}).`
      : `${signal} bias from ${aligned.join(", ")}.`

  return {
    signal,
    confidence: Number(confidence.toFixed(3)),
    reason,
    rsi: Number(r.toFixed(1)),
    atr: Number(a.toFixed(last < 1 ? 5 : 2)),
    entry: entry ? Number(entry.toFixed(last < 1 ? 5 : 2)) : 0,
    tp: tp ? Number(tp.toFixed(last < 1 ? 5 : 2)) : 0,
    sl: sl ? Number(sl.toFixed(last < 1 ? 5 : 2)) : 0,
  }
}
