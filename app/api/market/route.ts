import { NextResponse } from "next/server"
import type { Consensus, MarketResponse, MarketRow, TrendState, WhaleBias } from "@/lib/types"
import { computeSignal } from "@/lib/signals"

// Real public market data + genuine technical analytics, computed server-side so
// the terminal behaves identically on localhost and on Vercel (no CORS, no
// browser geo-block, no API key).
//
// Source: OKX public v5 API (perpetual swaps) — real last price, 24h move, open
// interest, long/short account ratio and OHLC candles. From those candles we
// derive RSI / moving-average cross / momentum / ATR targets and a consensus
// verdict. Nothing here is mocked.

export const dynamic = "force-dynamic"
export const revalidate = 0

const SYMBOLS: { symbol: string; base: string }[] = [
  { symbol: "BTCUSDT", base: "BTC" },
  { symbol: "ETHUSDT", base: "ETH" },
  { symbol: "SOLUSDT", base: "SOL" },
  { symbol: "BNBUSDT", base: "BNB" },
  { symbol: "XRPUSDT", base: "XRP" },
  { symbol: "DOGEUSDT", base: "DOGE" },
  { symbol: "AVAXUSDT", base: "AVAX" },
  { symbol: "LINKUSDT", base: "LINK" },
]

const OKX = (process.env.MARKET_API_BASE || "https://www.okx.com").replace(/\/$/, "")

async function okx(path: string): Promise<any | null> {
  try {
    const res = await fetch(OKX + path, {
      headers: { accept: "application/json" },
      next: { revalidate: 15 },
    })
    if (!res.ok) return null
    const json = await res.json()
    if (json?.code !== "0") return null
    return json.data
  } catch {
    return null
  }
}

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

async function buildRow(def: { symbol: string; base: string }, ticker: any): Promise<MarketRow> {
  const instId = `${def.base}-USDT-SWAP`

  const [candleData, oiData, lsrData] = await Promise.all([
    okx(`/api/v5/market/candles?instId=${instId}&bar=1H&limit=100`),
    okx(`/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
    okx(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${def.base}&period=1H&limit=1`),
  ])

  // OKX candles are newest-first: [ts, o, h, l, c, vol, ...]. Reverse to chronological.
  const rows: string[][] = Array.isArray(candleData) ? [...candleData].reverse() : []
  const closes = rows.map((c) => Number(c[4])).filter((n) => Number.isFinite(n))
  const highs = rows.map((c) => Number(c[2])).filter((n) => Number.isFinite(n))
  const lows = rows.map((c) => Number(c[3])).filter((n) => Number.isFinite(n))

  const last = Number(ticker?.last) || closes[closes.length - 1] || 0
  const open24h = Number(ticker?.open24h) || last
  const pct24h = open24h ? ((last - open24h) / open24h) * 100 : 0

  const oiUsd = Array.isArray(oiData) && oiData[0] ? Number(oiData[0].oiUsd) : 0
  const lsr = Array.isArray(lsrData) && lsrData[0] ? Number(lsrData[0][1]) : 1

  const trendState = trendFromCloses(closes)
  const whaleBias = whaleFromLsr(lsr)

  const sig = computeSignal({ closes, highs, lows, lsr, trend: trendState, whale: whaleBias })

  return {
    symbol: def.symbol,
    lastPrice: last,
    pct24h: Number(pct24h.toFixed(2)),
    openInterest: Number.isFinite(oiUsd) ? oiUsd : 0,
    lsrVal: Number.isFinite(lsr) ? Number(lsr.toFixed(3)) : 1,
    trendState,
    whaleBias,
    signalStatus: sig.signal,
    confidence: sig.confidence,
    rsi: sig.rsi,
    spark: closes.slice(-40),
    // carry derived targets so the consensus picker can reuse them
    _entry: sig.entry,
    _tp: sig.tp,
    _sl: sig.sl,
    _reason: sig.reason,
  } as MarketRow & { _entry: number; _tp: number; _sl: number; _reason: string }
}

// Pick the highest-conviction directional row as the live analytics consensus.
function pickConsensus(market: (MarketRow & { _entry?: number; _tp?: number; _sl?: number; _reason?: string })[], ts: number): Consensus | null {
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

export async function GET() {
  const tickers = await okx("/api/v5/market/tickers?instType=SWAP")

  if (!Array.isArray(tickers)) {
    const body: MarketResponse = { ok: false, ts: Date.now(), market: [], consensus: null, error: "market feed unavailable" }
    return NextResponse.json(body, { status: 502 })
  }

  const byInst = new Map<string, any>()
  for (const t of tickers) byInst.set(t.instId, t)

  const market = await Promise.all(
    SYMBOLS.map((def) => buildRow(def, byInst.get(`${def.base}-USDT-SWAP`))),
  )

  const ts = Date.now()
  const consensus = pickConsensus(market as any, ts)

  // strip internal helper fields before sending to the client
  const clean: MarketRow[] = market.map((m) => {
    const { _entry, _tp, _sl, _reason, ...rest } = m as any
    return rest as MarketRow
  })

  const body: MarketResponse = { ok: true, ts, market: clean, consensus }
  return NextResponse.json(body)
}
