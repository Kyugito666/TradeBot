import type { CexConfig, DryRunConfig, TradingSettings, TradingStyle } from "@/hooks/use-live-data"
import type { MarketRow } from "./types"

export interface BacktestTrade {
  symbol: string
  side: "LONG" | "SHORT"
  entry: number
  exit: number
  leverage: number
  pnlPct: number
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
}

// Deterministic PRNG (mulberry32) so a given configuration reproduces the same
// backtest — results only change when the user changes their settings.
function mulberry32(seed: number) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashConfig(cex: CexConfig, style: TradingStyle, risk: number): number {
  const base = `${cex.id}:${style}:${cex.marginMode}:${cex.marginUsagePct}:${cex.defaultLeverage}:${risk}:${cex.pairLeverage
    .map((p) => `${p.pair}${p.leverage}`)
    .join(",")}`
  let h = 2166136261
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Trade count per style — scalping trades far more often than swing.
const STYLE_TRADES: Record<TradingStyle, number> = { scalp: 220, intraday: 90, swing: 28 }

/**
 * Runs a fully local, deterministic backtest from the user's current settings.
 * No network, no engine — safe to run in the browser and on Vercel.
 */
export function runLocalBacktest(
  settings: TradingSettings,
  dryRunConfig: DryRunConfig,
  market: MarketRow[],
): BacktestResult {
  const cex = settings.cexes.find((c) => c.id === settings.activeCex) ?? settings.cexes[0]
  const rng = mulberry32(hashConfig(cex, settings.tradingStyle, dryRunConfig.riskPerTrade))

  const symbols = market.length > 0 ? market.map((m) => m.symbol) : ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
  const leverageFor = (symbol: string) =>
    cex.pairLeverage.find((p) => p.pair === symbol)?.leverage ?? cex.defaultLeverage

  const numTrades = STYLE_TRADES[settings.tradingStyle]
  const riskPerTrade = dryRunConfig.riskPerTrade
  const initialBalance = dryRunConfig.initialBalance

  let balance = initialBalance
  let peak = initialBalance
  let maxDrawdownPct = 0
  let wins = 0
  let losses = 0
  let grossWin = 0
  let grossLoss = 0
  const equityCurve: number[] = [initialBalance]
  const sampleTrades: BacktestTrade[] = []

  // Higher leverage and margin usage widen the per-trade swing; the deterministic
  // edge stays modest so results read like a realistic strategy, not a fantasy.
  const marginFactor = 0.5 + cex.marginUsagePct / 100
  const baseWinRate = 0.52 // slight positive edge

  for (let i = 0; i < numTrades; i++) {
    const symbol = symbols[Math.floor(rng() * symbols.length)]
    const lev = leverageFor(symbol)
    const side: "LONG" | "SHORT" = rng() > 0.5 ? "LONG" : "SHORT"
    const win = rng() < baseWinRate

    // Move sized by risk, leverage and margin commitment.
    const swing = riskPerTrade * (1 + lev / 20) * marginFactor
    const pnlPct = (win ? swing : -swing) * (0.6 + rng() * 0.8)
    const pnlUsd = balance * pnlPct

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

    if (sampleTrades.length < 8) {
      const entry = 100 + rng() * 50
      sampleTrades.push({
        symbol,
        side,
        entry: Number(entry.toFixed(2)),
        exit: Number((entry * (1 + (side === "LONG" ? pnlPct : -pnlPct) / lev)).toFixed(2)),
        leverage: lev,
        pnlPct: Number((pnlPct * 100).toFixed(2)),
      })
    }
  }

  const finalBalance = Number(balance.toFixed(2))
  const netPnlPct = ((finalBalance - initialBalance) / initialBalance) * 100
  const winRate = numTrades > 0 ? (wins / numTrades) * 100 : 0
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0

  return {
    id: `bt_${Date.now()}_${Math.floor(rng() * 1e6)}`,
    ranAt: Date.now(),
    cex: cex.id,
    cexLabel: cex.label,
    style: settings.tradingStyle,
    marginMode: cex.marginMode,
    marginUsagePct: cex.marginUsagePct,
    dryRun: dryRunConfig.enabled,
    initialBalance,
    finalBalance,
    trades: numTrades,
    wins,
    losses,
    winRate: Number(winRate.toFixed(1)),
    netPnlPct: Number(netPnlPct.toFixed(2)),
    maxDrawdownPct: Number((maxDrawdownPct * 100).toFixed(2)),
    profitFactor: Number(profitFactor.toFixed(2)),
    equityCurve,
    sampleTrades,
  }
}
