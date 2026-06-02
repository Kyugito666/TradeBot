import { NextResponse } from "next/server"
import type { MarketRow, TrendState, WhaleBias } from "@/lib/types"

// Real public market data, fetched server-side so it works identically on
// localhost and on Vercel (no CORS, no geo-block on the browser side).
//
// Primary source: OKX public v5 API (perpetual swaps). It exposes real last
// price, 24h move, open interest, long/short account ratio and candles.

export const dynamic = "force-dynamic"
export const revalidate = 0

// Symbols tracked by the terminal. base is used to build OKX instIds.
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

const OKX = "https://www.okx.com"

async function okx(path: string): Promise<any | null> {
  try {
    const res = await fetch(OKX + path, {
      headers: { accept: "application/json" },
      // brief edge cache to stay well under rate limits while staying live
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
    okx(`/api/v5/market/candles?instId=${instId}&bar=1H&limit=48`),
    okx(`/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
    okx(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${def.base}&period=1H&limit=1`),
  ])

  // candles come newest-first → reverse to chronological closes
  const closes: number[] = Array.isArray(candleData)
    ? candleData
        .map((c: string[]) => Number(c[4]))
        .filter((n) => Number.isFinite(n))
        .reverse()
    : []

  const last = Number(ticker?.last) || closes[closes.length - 1] || 0
  const open24h = Number(ticker?.open24h) || last
  const pct24h = open24h ? ((last - open24h) / open24h) * 100 : 0

  const oiUsd = Array.isArray(oiData) && oiData[0] ? Number(oiData[0].oiUsd) : 0
  const lsr = Array.isArray(lsrData) && lsrData[0] ? Number(lsrData[0][1]) : 1

  return {
    symbol: def.symbol,
    lastPrice: last,
    pct24h: Number(pct24h.toFixed(2)),
    openInterest: Number.isFinite(oiUsd) ? oiUsd : 0,
    lsrVal: Number.isFinite(lsr) ? Number(lsr.toFixed(3)) : 1,
    trendState: trendFromCloses(closes),
    whaleBias: whaleFromLsr(lsr),
    signalStatus: "WAIT",
    confidence: 0,
    spark: closes.slice(-40),
  }
}

export async function GET() {
  const tickers = await okx("/api/v5/market/tickers?instType=SWAP")

  if (!Array.isArray(tickers)) {
    return NextResponse.json(
      { ok: false, error: "market feed unavailable", market: [] },
      { status: 502 },
    )
  }

  const byInst = new Map<string, any>()
  for (const t of tickers) byInst.set(t.instId, t)

  const market = await Promise.all(
    SYMBOLS.map((def) => buildRow(def, byInst.get(`${def.base}-USDT-SWAP`))),
  )

  return NextResponse.json({ ok: true, ts: Date.now(), market })
}
