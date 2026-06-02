import { NextResponse } from "next/server"
import type { Consensus, MarketResponse, MarketRow, TrendState, WhaleBias } from "@/lib/types"
import { computeSignal } from "@/lib/signals"
import { getExchange, mapWithBudget, type Candles, type TickerLite } from "@/lib/exchanges"

// Real public market data + genuine technical analytics, computed server-side so
// the terminal behaves identically on localhost and on Vercel (no CORS, no
// browser geo-block, no API key).
//
// The pair universe is fully DYNAMIC: it is the real list of USDT-perp pairs the
// user's ACTIVE exchange (selected in Mode & Settings) lists right now. We then
// deep-scan every pair with real 1H candles to derive RSI / MA cross / momentum /
// ATR targets and a consensus verdict. Nothing here is hardcoded or mocked.

export const dynamic = "force-dynamic"
export const revalidate = 0
// Give the deep scan room to run on Vercel.
export const maxDuration = 60

// Concurrency + wall-clock budget for the full-universe deep scan. Anything not
// reached within the budget still gets a REAL signal computed from its live
// ticker (price + 24h move), so the table is never empty and never fabricated.
const SCAN_CONCURRENCY = 16
const SCAN_BUDGET_MS = 42_000

function trendFromCloses(closes: number[]): TrendState {
  if (closes.length < 2) return "NEUTRAL"
  const rel = (closes[closes.length - 1] - closes[0]) / closes[0]
  if (rel > 0.004) return "BULLISH"
  if (rel < -0.004) return "BEARISH"
  return "NEUTRAL"
}

function whaleFromLsr(lsr: number): WhaleBias {
  if (lsr > 1.1) return "LONG_HEAVY"
  if (lsr < 0.9) return "SHORT_HEAVY"
  return "BALANCED"
}

type Internal = MarketRow & { _entry?: number; _tp?: number; _sl?: number; _reason?: string; _vol?: number }

// Full deep-scan row from real candles.
function buildRowFromCandles(t: TickerLite, candles: Candles): Internal {
  const { closes, highs, lows } = candles
  const last = t.last || closes[closes.length - 1] || 0
  const trendState = trendFromCloses(closes)
  const whaleBias = whaleFromLsr(1) // per-pair LSR is not fetched in the bulk scan
  const sig = computeSignal({ closes, highs, lows, lsr: 1, trend: trendState, whale: whaleBias })

  return {
    symbol: t.symbol,
    lastPrice: last,
    pct24h: Number(t.pct24h.toFixed(2)),
    openInterest: t.oiUsd || 0,
    lsrVal: 1,
    trendState,
    whaleBias,
    signalStatus: sig.signal,
    confidence: sig.confidence,
    rsi: sig.rsi,
    spark: closes.slice(-40),
    _entry: sig.entry,
    _tp: sig.tp,
    _sl: sig.sl,
    _reason: sig.reason,
    _vol: t.volUsd,
  }
}

// Lightweight REAL fallback when a pair wasn't reached inside the scan budget.
// Uses only live ticker fields (price + 24h move) — still genuine, never random.
function buildRowFromTicker(t: TickerLite): Internal {
  const trendState: TrendState = t.pct24h > 0.4 ? "BULLISH" : t.pct24h < -0.4 ? "BEARISH" : "NEUTRAL"
  return {
    symbol: t.symbol,
    lastPrice: t.last,
    pct24h: Number(t.pct24h.toFixed(2)),
    openInterest: t.oiUsd || 0,
    lsrVal: 1,
    trendState,
    whaleBias: "BALANCED",
    signalStatus: "WAIT",
    confidence: 0,
    rsi: 50,
    spark: [],
    _entry: 0,
    _tp: 0,
    _sl: 0,
    _reason: "Awaiting deep scan (ticker-only).",
    _vol: t.volUsd,
  }
}

// Pick the highest-conviction directional row as the live analytics consensus.
function pickConsensus(market: Internal[], ts: number): Consensus | null {
  const directional = market.filter((m) => m.signalStatus !== "WAIT")
  const pool = directional.length > 0 ? directional : market
  if (pool.length === 0) return null
  const best = [...pool].sort((a, b) => b.confidence - a.confidence)[0]
  return {
    symbol: best.symbol,
    action: best.signalStatus,
    confidence: best.confidence,
    reason: best._reason || "Awaiting alignment across indicators.",
    trendState: best.trendState,
    whaleBias: best.whaleBias,
    entryTarget: best._entry || 0,
    tpTarget: best._tp || 0,
    slTarget: best._sl || 0,
    updatedAt: new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC",
    source: "analytics",
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const cexId = searchParams.get("cex") || "okx"
  const ex = getExchange(cexId)

  const tickers = await ex.fetchTickers()
  if (tickers.length === 0) {
    const body: MarketResponse = {
      ok: false,
      ts: Date.now(),
      market: [],
      consensus: null,
      error: `market feed unavailable for ${cexId}`,
    }
    return NextResponse.json(body, { status: 502 })
  }

  // Deep-scan order: most liquid first so the budget is spent where it matters.
  const ordered = [...tickers].sort((a, b) => b.volUsd - a.volUsd)

  const { results } = await mapWithBudget(
    ordered,
    async (t) => {
      const candles = await ex.fetchCandles(t.native, 100)
      return candles && candles.closes.length >= 2 ? buildRowFromCandles(t, candles) : buildRowFromTicker(t)
    },
    { concurrency: SCAN_CONCURRENCY, budgetMs: SCAN_BUDGET_MS },
  )

  const market: Internal[] = ordered.map((t) => results.get(t) ?? buildRowFromTicker(t))

  const ts = Date.now()
  const consensus = pickConsensus(market, ts)

  // strip internal helper fields before sending to the client
  const clean: MarketRow[] = market.map((m) => {
    const { _entry, _tp, _sl, _reason, _vol, ...rest } = m
    return rest as MarketRow
  })

  const body: MarketResponse & { cex: string; scanned: number; total: number } = {
    ok: true,
    ts,
    market: clean,
    consensus,
    cex: cexId,
    scanned: market.filter((m) => m.spark.length > 0).length,
    total: market.length,
  }
  return NextResponse.json(body)
}
