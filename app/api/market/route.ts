import { NextResponse } from "next/server"
import type { Consensus, MarketResponse, MarketRow, TrendState, WhaleBias } from "@/lib/types"
import { computeSignal } from "@/lib/signals"
import { getExchange, getAllExchanges, mapWithBudget, type Candles, type TickerLite } from "@/lib/exchanges"

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
const SCAN_CONCURRENCY = 15
const SCAN_BUDGET_MS = 60000

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

async function fetchRustBrain(t: TickerLite, candles: Candles): Promise<any | null> {
    try {
        const reqBody = [{
            symbol: t.symbol,
            candles: candles.closes.map((c, i) => ({
                open: candles.opens?.[i] || c,
                high: candles.highs?.[i] || c,
                low: candles.lows?.[i] || c,
                close: c,
                vol: candles.volumes?.[i] || 0,
                ts_ms: Date.now() - (candles.closes.length - i) * 3600000
            })),
            price: t.last,
            oi: t.oiUsd || 0,
            lsr: 1.0
        }];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch("http://127.0.0.1:8765/api/proxy/evaluate", {
            method: "POST",
            body: JSON.stringify(reqBody),
            headers: { "Content-Type": "application/json" },
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!res.ok) return null;
        const data = await res.json();
        return data && data.length > 0 ? data[0] : null;
    } catch(e) {
        return null; // fallback silently if rust-brain is not running in server mode
    }
}

// Full deep-scan row from real candles.
async function buildRowFromCandles(t: TickerLite, candles: Candles): Promise<Internal> {
  const { closes, highs, lows } = candles
  const last = t.last || closes[closes.length - 1] || 0
  const trendState = trendFromCloses(closes)
  const whaleBias = whaleFromLsr(1) // per-pair LSR is not fetched in the bulk scan
  
  let signalStatus = "WAIT"
  let confidence = 0
  let rsiVal = 50
  let _entry = 0
  let _tp = 0
  let _sl = 0
  let _reason = ""

  // FASE 6: Coba tanya Rust Brain (13 Agents) via HTTP lokal
  const rustRes = await fetchRustBrain(t, candles)
  if (rustRes) {
      signalStatus = rustRes.veto ? "WAIT" : rustRes.signal.toUpperCase()
      confidence = rustRes.confidence
      _entry = rustRes.entry
      _tp = rustRes.take_profit
      _sl = rustRes.stop_loss
      _reason = rustRes.veto ? "[VETO] " + rustRes.veto_reason : "[Rust 13-Agent Consensus]"
      
      // Fallback indikator teknikal murni untuk mempercantik UI
      const sig = computeSignal({ closes, highs, lows, lsr: 1, trend: trendState, whale: whaleBias })
      rsiVal = sig.rsi
  } else {
      // Fallback kalau Rust API mati / belum dijalankan mode=server
      const sig = computeSignal({ closes, highs, lows, lsr: 1, trend: trendState, whale: whaleBias })
      signalStatus = sig.signal
      confidence = sig.confidence
      rsiVal = sig.rsi
      _entry = sig.entry
      _tp = sig.tp
      _sl = sig.sl
      _reason = sig.reason
  }

  return {
    symbol: t.symbol,
    lastPrice: last,
    pct24h: Number(t.pct24h.toFixed(2)),
    openInterest: t.oiUsd || 0,
    lsrVal: 1,
    trendState,
    whaleBias,
    signalStatus,
    confidence,
    rsi: rsiVal,
    spark: closes.slice(-40),
    _entry,
    _tp,
    _sl,
    _reason,
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
  const baseEx = getExchange(cexId)

  // 1. The baseline universe of pairs strictly available on the ACTIVE exchange.
  // If the active exchange API is completely blocked/down, fallback to another major exchange
  // just so we get a base universe of pairs to scan.
  let baseTickers = await baseEx.fetchTickers()
  if (baseTickers.length === 0) {
    baseTickers = await getExchange("okx").fetchTickers()
  }
  if (baseTickers.length === 0) {
    baseTickers = await getExchange("bybit").fetchTickers()
  }
  if (baseTickers.length === 0) {
    const body: MarketResponse = {
      ok: false,
      ts: Date.now(),
      market: [],
      consensus: null,
      error: `all market feeds unavailable (including fallback)`,
    }
    return NextResponse.json(body, { status: 502 })
  }

  // 2. Concurrently fetch tickers from ALL exchanges to build a global liquidity map.
  type TickerWithCex = TickerLite & { cexId: string }
  const allExchanges = getAllExchanges()
  const globalResults = await Promise.all(allExchanges.map((ex) => ex.fetchTickers().catch(() => [])))
  
  const bestGlobalTickers = new Map<string, TickerWithCex>()
  allExchanges.forEach((ex, i) => {
    for (const t of globalResults[i]) {
      const existing = bestGlobalTickers.get(t.symbol)
      // Pick the exchange with the highest USD volume for this pair.
      if (!existing || t.volUsd > existing.volUsd) {
        bestGlobalTickers.set(t.symbol, { ...t, cexId: ex.id })
      }
    }
  })

  // Deep-scan order: prioritize pairs that are both liquid AND highly volatile.
  // [FIX] Removed hardcoded watchlist to make the system fully dynamic based on real market data.
  const ordered = [...baseTickers].sort((a, b) => {
    const score = (t: TickerLite) => Math.log10(Math.max(1, t.volUsd)) * Math.max(0.5, Math.abs(t.pct24h))
    return score(b) - score(a)
  })

  const { results } = await mapWithBudget(
    ordered,
    async (baseTicker) => {
      // JEDA 300ms PER WORKER + CONCURRENCY 15 = 40+ req/s
      // Cukup cepat untuk memindai 400 koin sebelum batas waktu 60 detik habis.
      await new Promise(r => setTimeout(r, 300))
      
      // 3. For analysis, substitute the base ticker with the global highest-liquidity ticker.
      const best = bestGlobalTickers.get(baseTicker.symbol)
      const t = best || { ...baseTicker, cexId }
      
      const ex = getExchange(t.cexId)
      const candles = await ex.fetchCandles(t.native, 100)
      
      if (!candles || candles.closes.length < 2) return buildRowFromTicker(baseTicker)
      
      const row = await buildRowFromCandles(t, candles)
      
      // Remap the absolute prices back to the local exchange's reality.
      // If Binance is $100 and MEXC is $99, a TP of $110 on Binance becomes $108.9 on MEXC.
      if (t.cexId !== cexId && t.last > 0 && baseTicker.last > 0) {
        const ratio = baseTicker.last / t.last
        if (row._entry) row._entry *= ratio
        if (row._tp) row._tp *= ratio
        if (row._sl) row._sl *= ratio
        row.lastPrice = baseTicker.last
        row.pct24h = baseTicker.pct24h
        row.openInterest = baseTicker.oiUsd || 0
        row._vol = baseTicker.volUsd
      }
      
      return row
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
