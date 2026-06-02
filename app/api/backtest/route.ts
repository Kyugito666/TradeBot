import { NextResponse } from "next/server"
import { getExchange, mapWithBudget, TIMEFRAME_MS, type Timeframe } from "@/lib/exchanges"
import { replayBacktest, type BacktestRiskModel, type PairCandles, type TradingStyle } from "@/lib/backtest"

// POST /api/backtest — run a REAL backtest over historical candles of the active
// exchange's pairs, using the same signal + TP/SL strategy as Signals/Consensus.
//
// Body: {
//   cex, cexLabel, style, risk, dryRun, initialBalance, riskPerTrade,
//   marginMode, marginUsagePct, defaultLeverage,
//   pairLeverage: { pair: leverage }, symbols?: string[]
// }
export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 60

// Hard cap on candles requested per pair so a manual backtest stays responsive
// regardless of the chosen period/timeframe. Most venues cap their kline feed
// near this anyway.
// Most venues cap their kline feed near 1500 candles per request; we request up
// to that so longer (multi-year) lookback windows pull as much real history as
// the exchange will give. Daily candles reach furthest back at this cap.
const MAX_CANDLES = 1500
const MIN_CANDLES = 60
const SCAN_CONCURRENCY = 12
const SCAN_BUDGET_MS = 45_000
// Cap the universe so a manual backtest stays responsive; the most liquid pairs
// (which is what the live tabs surface first) are always covered.
const MAX_PAIRS = 120

const VALID_TIMEFRAMES: Timeframe[] = ["15m", "1h", "4h", "1d"]

interface Body {
  cex?: string
  cexLabel?: string
  style?: TradingStyle
  risk?: BacktestRiskModel
  dryRun?: boolean
  initialBalance?: number
  riskPerTrade?: number
  marginMode?: string
  marginUsagePct?: number
  defaultLeverage?: number
  pairLeverage?: Record<string, number>
  symbols?: string[]
  /** Candle timeframe selected in the app (15m / 1h / 4h / 1d). */
  timeframe?: Timeframe
  /** Backtest lookback window, in days. */
  periodDays?: number
  /** The pair currently selected/analysed in the app — drives the replay chart. */
  focusSymbol?: string
}

export async function POST(request: Request) {
  let body: Body
  try {
    body = (await request.json()) as Body
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 })
  }

  const cexId = body.cex || "okx"
  const ex = getExchange(cexId)
  const style: TradingStyle = body.style || "intraday"
  const risk: BacktestRiskModel = body.risk || {
    preset: "balanced",
    atrMultiplier: 2,
    riskReward: 2,
    targetRoiPct: 10,
    maxPnlPct: 1,
  }
  const defaultLeverage = body.defaultLeverage ?? 5
  const pairLeverage = body.pairLeverage ?? {}

  // ── Resolve the candle timeframe + lookback period chosen in the UI. ──────────
  // The number of candles fetched is derived from (period × bars-per-day), so a
  // longer period or a finer timeframe pulls more historical data into the run.
  const timeframe: Timeframe = VALID_TIMEFRAMES.includes(body.timeframe as Timeframe)
    ? (body.timeframe as Timeframe)
    : "1h"
  const periodDays = clampNum(body.periodDays ?? 12, 1, 1095)
  const barsPerDay = 86_400_000 / TIMEFRAME_MS[timeframe]
  const candleLimit = Math.max(MIN_CANDLES, Math.min(MAX_CANDLES, Math.ceil(periodDays * barsPerDay)))
  const focusSymbol = body.focusSymbol?.toUpperCase()

  const tickers = await ex.fetchTickers()
  if (tickers.length === 0) {
    return NextResponse.json({ ok: false, error: `market feed unavailable for ${cexId}` }, { status: 502 })
  }

  // Use the same dynamic universe as the live tabs. If the client passed the
  // currently-shown symbols, honour that exact set; otherwise rank by liquidity.
  const wanted = body.symbols && body.symbols.length > 0 ? new Set(body.symbols.map((s) => s.toUpperCase())) : null
  let universe = wanted ? tickers.filter((t) => wanted.has(t.symbol.toUpperCase())) : [...tickers]
  universe.sort((a, b) => b.volUsd - a.volUsd)
  universe = universe.slice(0, MAX_PAIRS)

  // Guarantee the focused pair (the one the user is looking at) is part of the
  // run even if it falls outside the top-liquidity slice, so the replay chart
  // can always show the real candles of the selected pair.
  if (focusSymbol && !universe.some((t) => t.symbol.toUpperCase() === focusSymbol)) {
    const focusTicker = tickers.find((t) => t.symbol.toUpperCase() === focusSymbol)
    if (focusTicker) universe = [focusTicker, ...universe]
  }

  const levOf = (symbol: string) => pairLeverage[symbol] ?? pairLeverage[symbol.toUpperCase()] ?? defaultLeverage

  const { results } = await mapWithBudget(
    universe,
    async (t): Promise<PairCandles | null> => {
      const c = await ex.fetchCandles(t.native, candleLimit, timeframe)
      if (!c || c.closes.length < 40) return null
      return {
        symbol: t.symbol,
        leverage: levOf(t.symbol),
        opens: c.opens,
        highs: c.highs,
        lows: c.lows,
        closes: c.closes,
      }
    },
    { concurrency: SCAN_CONCURRENCY, budgetMs: SCAN_BUDGET_MS },
  )

  const pairs: PairCandles[] = []
  for (const t of universe) {
    const r = results.get(t)
    if (r) pairs.push(r)
  }

  if (pairs.length === 0) {
    return NextResponse.json({ ok: false, error: "No candle history available to backtest" }, { status: 502 })
  }

  const result = replayBacktest(pairs, {
    cex: cexId,
    cexLabel: body.cexLabel || cexId.toUpperCase(),
    style,
    risk,
    dryRun: body.dryRun ?? true,
    initialBalance: body.initialBalance ?? 10000,
    riskPerTrade: body.riskPerTrade ?? risk.maxPnlPct / 100,
    marginMode: body.marginMode || "cross",
    marginUsagePct: body.marginUsagePct ?? 10,
    timeframe,
    periodDays,
    intervalMs: TIMEFRAME_MS[timeframe],
    focusSymbol,
  })

  return NextResponse.json({ ok: true, ts: Date.now(), result })
}

function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}
