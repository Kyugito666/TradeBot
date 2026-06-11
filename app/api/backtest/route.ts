import { NextResponse } from "next/server"
import { getExchange, mapWithBudget, TIMEFRAME_MS, type Timeframe, type Candles } from "@/lib/exchanges"
import { replayBacktest, type BacktestRiskModel, type PairCandles, type TradingStyle } from "@/lib/backtest"
import fs from "fs"
import path from "path"
import { execSync } from "child_process"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 60

const MAX_CANDLES = 500_000
const MIN_CANDLES = 60
const SCAN_CONCURRENCY = 8
const SCAN_BUDGET_MS = 45_000
const MAX_PAIRS = 9999

const VALID_TIMEFRAMES: Timeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d", "1w"]

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
  timeframe?: Timeframe
  periodDays?: number
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

  const timeframe: Timeframe = VALID_TIMEFRAMES.includes(body.timeframe as Timeframe)
    ? (body.timeframe as Timeframe)
    : "1h"
  const wanted = body.symbols && body.symbols.length > 0 ? new Set(body.symbols.map((s) => s.toUpperCase())) : null
  const isSinglePair = wanted !== null && wanted.size === 1
  const maxAllowedCandles = MAX_CANDLES
  
  const periodDays = clampNum(body.periodDays ?? 12, 1, 10000)
  const barsPerDay = 86_400_000 / TIMEFRAME_MS[timeframe]
  const candleLimit = Math.max(MIN_CANDLES, Math.min(maxAllowedCandles, Math.ceil(periodDays * barsPerDay)))
  const focusSymbol = body.focusSymbol?.toUpperCase()

  const tickers = await ex.fetchTickers()
  if (tickers.length === 0) {
    return NextResponse.json({ ok: false, error: `market feed unavailable for ${cexId}` }, { status: 502 })
  }

  let universe = wanted ? tickers.filter((t) => wanted.has(t.symbol.toUpperCase()) || wanted.has(t.base.toUpperCase())) : [...tickers]
  
  // DYNAMIC PAIR SELECTION (Based on history length, NOT top DB pairs)
  // We sort by volume but DO NOT slice to 120 here.
  // mapWithBudget will scan them and we will take the top 120 that actually survive the Adaptive History Filter below.
  if (!wanted || (!isSinglePair && wanted.size > 1)) {
    universe.sort((a, b) => b.volUsd - a.volUsd)
  }

  if (focusSymbol && !universe.some((t) => t.symbol.toUpperCase() === focusSymbol || t.base.toUpperCase() === focusSymbol)) {
    const focusTicker = tickers.find((t) => t.symbol.toUpperCase() === focusSymbol || t.base.toUpperCase() === focusSymbol)
    if (focusTicker) universe = [focusTicker, ...universe]
  }

  const levOf = (symbol: string) => pairLeverage[symbol] ?? pairLeverage[symbol.toUpperCase()] ?? defaultLeverage

    const { results } = await mapWithBudget(
    universe,
    async (t): Promise<PairCandles | null> => {
      // PHASE 1: Route candle history directly through Python ML Parquet engine
      try {
        const resp = await fetch("http://127.0.0.1:5000/api/ml/get_history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            symbol: t.native,
            exchange: cexId,
            timeframe: timeframe,
            period_days: periodDays
          })
        });
        
        if (!resp.ok) return null;
        
        const data = await resp.json();
        if (!data.ok || !data.closes || data.closes.length < MIN_CANDLES) return null;
        
        // FEATURE: ADAPTIVE PAIR FILTERING
        // Exclude pairs that don't meet at least 90% of the requested period history
        // so new coins don't skew long-term backtest results
        if (!isSinglePair) {
          const requiredCandles = Math.floor(candleLimit * 0.90)
          if (data.closes.length < requiredCandles) {
            return null
          }
        }
        
        return {
          symbol: t.symbol,
          leverage: levOf(t.symbol),
          opens: data.opens,
          highs: data.highs,
          lows: data.lows,
          closes: data.closes,
        }
      } catch (e) {
        console.error(`Failed to fetch history for ${t.symbol} from Python ML Engine:`, e)
        return null;
      }
    },
    { concurrency: SCAN_CONCURRENCY, budgetMs: SCAN_BUDGET_MS },
  )

  const pairs: PairCandles[] = []
  for (const t of universe) {
    const r = results.get(t)
    if (r) {
      pairs.push(r)
      if (pairs.length >= MAX_PAIRS) break
    }
  }

  if (pairs.length === 0) {
    return NextResponse.json({ ok: false, error: "No candle history available to backtest" }, { status: 502 })
  }

  const result = await replayBacktest(pairs, {
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

  // The Rust backend handles storing the DB, so we send the stats over HTTP
  try {
    const payload = {
      timestamp: result.ranAt || Date.now(),
      cex: result.cex || "",
      timeframe: result.timeframe || "",
      periodDays: result.periodDays || 0,
      profitFactor: result.profitFactor || 0,
      netPnlPct: result.netPnlPct || 0,
      trades: result.trades || 0,
      winRate: result.winRate || 0,
      scannedPairs: result.scannedPairs || 0,
      pairStats: result.pairStats || []
    }
    await fetch("http://127.0.0.1:8080/api/save_backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    })
  } catch (err) {
    console.error("Failed to send backtest result to Rust DB API", err)
  }

  return NextResponse.json({ ok: true, ts: Date.now(), result })
}

function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}
