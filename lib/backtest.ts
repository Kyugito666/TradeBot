// ────────────────────────────────────────────────────────────────────────────
// Real-pipeline backtest.
//
// This replays the EXACT SAME strategy that the Signals tab forward-tests and the
// Consensus tab votes on — `computeSignal()` (lib/signals.ts) for the directional
// call, and the same ATR%×risk:reward math (lib/signal-engine.ts `computeLevels`)
// for Entry / TP / SL — but over REAL historical 1H candles fetched from the
// active exchange. So Backtest, Signals and Consensus all share one data source
// and one strategy: results from the backtest describe the very pairs/signals the
// live tabs act on.
//
// Pure & deterministic: given the same candles + settings it always produces the
// same result. The candle fetching happens in /api/backtest (server) so this file
// stays a pure function usable anywhere.
// ────────────────────────────────────────────────────────────────────────────

import { atr, computeSignal } from "./signals"
import type { TrendState } from "./types"

// Local mirrors of the settings types (kept self-contained so server routes can
// import this without pulling in the client-only settings hook).
export type TradingStyle = "scalp" | "intraday" | "swing"

export interface BacktestRiskModel {
  preset: string
  atrMultiplier: number
  riskReward: number
  targetRoiPct: number
  maxPnlPct: number
}

export interface BacktestTrade {
  symbol: string
  side: "LONG" | "SHORT"
  entry: number
  exit: number
  leverage: number
  pnlPct: number
  outcome: "TP" | "SL"
}

export interface PairStat {
  symbol: string
  trades: number
  wins: number
  losses: number
  winRate: number
  expectancyR: number
  netRoiPct: number
}

export interface BacktestResult {
  id: string
  ranAt: number
  cex: string
  cexLabel: string
  style: TradingStyle
  marginMode: string
  marginUsagePct: number
  dryRun: boolean
  initialBalance: number
  finalBalance: number
  trades: number
  wins: number
  losses: number
  winRate: number
  netPnlPct: number
  maxDrawdownPct: number
  profitFactor: number
  equityCurve: number[]
  sampleTrades: BacktestTrade[]
  /** Per-pair performance — propagated to Signals/Consensus so all tabs share it. */
  pairStats: PairStat[]
  /** Number of pairs that had enough candles to replay. */
  scannedPairs: number
}

// One pair's full candle history for replay.
export interface PairCandles {
  symbol: string
  leverage: number
  opens: number[]
  highs: number[]
  lows: number[]
  closes: number[]
}

const STYLE_MIN_CONFIDENCE: Record<TradingStyle, number> = { scalp: 0.45, intraday: 0.35, swing: 0.3 }
const WARMUP = 30 // bars needed before the first signal can form

function trendFromWindow(closes: number[]): TrendState {
  if (closes.length < 2) return "NEUTRAL"
  const rel = (closes[closes.length - 1] - closes[0]) / closes[0]
  if (rel > 0.004) return "BULLISH"
  if (rel < -0.004) return "BEARISH"
  return "NEUTRAL"
}

interface ClosedTrade extends BacktestTrade {
  pnlR: number
  entryBar: number
}

// Replay a single pair, returning its closed trades (non-overlapping).
function replayPair(pair: PairCandles, style: TradingStyle, risk: BacktestRiskModel): ClosedTrade[] {
  const { closes, highs, lows } = pair
  const n = closes.length
  if (n < WARMUP + 5) return []

  const gate = STYLE_MIN_CONFIDENCE[style] ?? 0.35
  const trades: ClosedTrade[] = []

  let i = WARMUP
  while (i < n - 1) {
    const cl = closes.slice(0, i + 1)
    const hi = highs.slice(0, i + 1)
    const lo = lows.slice(0, i + 1)
    const trend = trendFromWindow(cl.slice(-20))
    const sig = computeSignal({ closes: cl, highs: hi, lows: lo, lsr: 1, trend, whale: "BALANCED" })

    if ((sig.signal === "LONG" || sig.signal === "SHORT") && sig.confidence >= gate) {
      const entry = closes[i]
      const a = atr(hi, lo, cl, 14)
      const atrPct = entry > 0 ? Math.min(0.08, Math.max(0.003, a / entry)) : 0.012
      const slDistPct = atrPct * risk.atrMultiplier
      const tpDistPct = slDistPct * risk.riskReward
      const side = sig.signal as "LONG" | "SHORT"
      const tp = side === "LONG" ? entry * (1 + tpDistPct) : entry * (1 - tpDistPct)
      const sl = side === "LONG" ? entry * (1 - slDistPct) : entry * (1 + slDistPct)

      // Walk forward to find which level the intrabar range hits first.
      let outcome: "TP" | "SL" | null = null
      let exitBar = i
      for (let j = i + 1; j < n; j++) {
        if (side === "LONG") {
          if (lows[j] <= sl) { outcome = "SL"; exitBar = j; break }
          if (highs[j] >= tp) { outcome = "TP"; exitBar = j; break }
        } else {
          if (highs[j] >= sl) { outcome = "SL"; exitBar = j; break }
          if (lows[j] <= tp) { outcome = "TP"; exitBar = j; break }
        }
      }
      if (outcome) {
        const exit = outcome === "TP" ? tp : sl
        const dir = side === "LONG" ? 1 : -1
        const priceMovePct = ((exit - entry) / entry) * dir
        const pnlR = outcome === "TP" ? risk.riskReward : -1
        trades.push({
          symbol: pair.symbol,
          side,
          entry,
          exit,
          leverage: pair.leverage,
          pnlPct: Number((priceMovePct * pair.leverage * 100).toFixed(2)),
          pnlR,
          outcome,
          entryBar: i,
        })
        i = exitBar + 1 // no overlapping trades on the same pair
        continue
      }
    }
    i++
  }
  return trades
}

export interface ReplayConfig {
  cex: string
  cexLabel: string
  style: TradingStyle
  risk: BacktestRiskModel
  dryRun: boolean
  initialBalance: number
  riskPerTrade: number // decimal (maxPnlPct/100)
  marginMode: string
  marginUsagePct: number
}

export function replayBacktest(pairs: PairCandles[], cfg: ReplayConfig): BacktestResult {
  const perPair = new Map<string, ClosedTrade[]>()
  const all: ClosedTrade[] = []
  let scannedPairs = 0

  for (const pair of pairs) {
    const trades = replayPair(pair, cfg.style, cfg.risk)
    if (pair.closes.length >= WARMUP + 5) scannedPairs++
    perPair.set(pair.symbol, trades)
    all.push(...trades)
  }

  // Combined equity curve — order every trade by the bar it opened on so the
  // sequential balance reads like a realistic run across the whole universe.
  all.sort((a, b) => a.entryBar - b.entryBar)

  let balance = cfg.initialBalance
  let peak = balance
  let maxDrawdownPct = 0
  let wins = 0
  let losses = 0
  let grossWin = 0
  let grossLoss = 0
  const equityCurve: number[] = [Number(balance.toFixed(2))]

  for (const t of all) {
    // Size by the risk model: each trade risks `riskPerTrade` of balance (= 1R).
    const riskAmount = balance * cfg.riskPerTrade
    const pnlUsd = t.pnlR * riskAmount
    balance += pnlUsd
    if (balance > peak) peak = balance
    const dd = peak > 0 ? (peak - balance) / peak : 0
    if (dd > maxDrawdownPct) maxDrawdownPct = dd
    if (pnlUsd >= 0) {
      wins++
      grossWin += pnlUsd
    } else {
      losses++
      grossLoss += Math.abs(pnlUsd)
    }
    equityCurve.push(Number(balance.toFixed(2)))
  }

  const finalBalance = Number(balance.toFixed(2))
  const totalTrades = all.length
  const netPnlPct = cfg.initialBalance > 0 ? ((finalBalance - cfg.initialBalance) / cfg.initialBalance) * 100 : 0
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0

  const pairStats: PairStat[] = []
  for (const [symbol, trades] of perPair) {
    if (trades.length === 0) continue
    const w = trades.filter((t) => t.outcome === "TP").length
    const l = trades.length - w
    const netR = trades.reduce((a, t) => a + t.pnlR, 0)
    const netRoiPct = trades.reduce((a, t) => a + t.pnlPct, 0)
    pairStats.push({
      symbol,
      trades: trades.length,
      wins: w,
      losses: l,
      winRate: Number(((w / trades.length) * 100).toFixed(1)),
      expectancyR: Number((netR / trades.length).toFixed(3)),
      netRoiPct: Number(netRoiPct.toFixed(1)),
    })
  }
  pairStats.sort((a, b) => b.expectancyR - a.expectancyR)

  const sampleTrades: BacktestTrade[] = all.slice(0, 8).map((t) => ({
    symbol: t.symbol,
    side: t.side,
    entry: Number(t.entry.toFixed(t.entry < 1 ? 5 : 2)),
    exit: Number(t.exit.toFixed(t.exit < 1 ? 5 : 2)),
    leverage: t.leverage,
    pnlPct: t.pnlPct,
    outcome: t.outcome,
  }))

  return {
    id: `bt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    ranAt: Date.now(),
    cex: cfg.cex,
    cexLabel: cfg.cexLabel,
    style: cfg.style,
    marginMode: cfg.marginMode,
    marginUsagePct: cfg.marginUsagePct,
    dryRun: cfg.dryRun,
    initialBalance: cfg.initialBalance,
    finalBalance,
    trades: totalTrades,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    netPnlPct: Number(netPnlPct.toFixed(2)),
    maxDrawdownPct: Number((maxDrawdownPct * 100).toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    equityCurve,
    sampleTrades,
    pairStats,
    scannedPairs,
  }
}
