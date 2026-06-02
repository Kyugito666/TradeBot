import { NextResponse } from "next/server"
import { getExchange, mapWithBudget } from "@/lib/exchanges"
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

const CANDLE_LIMIT = 300 // ~12 days of 1H bars per pair for a meaningful replay
const SCAN_CONCURRENCY = 12
const SCAN_BUDGET_MS = 45_000
// Cap the universe so a manual backtest stays responsive; the most liquid pairs
// (which is what the live tabs surface first) are always covered.
const MAX_PAIRS = 120

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

  const levOf = (symbol: string) => pairLeverage[symbol] ?? pairLeverage[symbol.toUpperCase()] ?? defaultLeverage

  const { results } = await mapWithBudget(
    universe,
    async (t): Promise<PairCandles | null> => {
      const c = await ex.fetchCandles(t.native, CANDLE_LIMIT)
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
  })

  return NextResponse.json({ ok: true, ts: Date.now(), result })
}
