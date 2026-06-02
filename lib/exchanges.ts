// ────────────────────────────────────────────────────────────────────────────
// Multi-CEX public market-data adapter.
//
// Every supported exchange exposes the SAME shape to the rest of the app:
//   • fetchTickers()  → the FULL, REAL list of USDT perpetual pairs (one call).
//   • fetchCandles()  → 1H OHLCV for a single pair (chronological, oldest→newest).
//   • fetchExtras()   → open-interest / long-short ratio / funding (best-effort).
//
// Nothing here is hardcoded or mocked. The pair universe shown in Signals /
// Consensus / Backtest is whatever the chosen exchange actually lists right now.
// ────────────────────────────────────────────────────────────────────────────

export type CexId = "mexc" | "binance" | "bybit" | "bitget" | "gateio" | "okx"

// Candle timeframes supported across every exchange. The app/backtest pick ONE
// of these; each adapter maps it to that venue's native interval string below.
export type Timeframe = "15m" | "1h" | "4h" | "1d"

// Milliseconds per bar — used to label replay periods and to translate a
// lookback window (in days) into a candle count.
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
}

// Per-exchange native interval strings for each supported timeframe.
const TF_NATIVE: Record<CexId, Record<Timeframe, string>> = {
  okx: { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" },
  binance: { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" },
  bybit: { "15m": "15", "1h": "60", "4h": "240", "1d": "D" },
  bitget: { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" },
  gateio: { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" },
  mexc: { "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1" },
}

function tfNative(cex: CexId, tf: Timeframe): string {
  return TF_NATIVE[cex][tf] ?? TF_NATIVE[cex]["1h"]
}

export interface TickerLite {
  /** Canonical app symbol, always BASE+USDT (e.g. "BTCUSDT"). */
  symbol: string
  /** Base asset (e.g. "BTC"). */
  base: string
  /** Exchange-native instrument id used for candle/extra calls. */
  native: string
  last: number
  pct24h: number
  /** 24h notional volume in USD (used for liquidity ranking). */
  volUsd: number
  /** Open interest in USD when the ticker feed already carries it (else 0). */
  oiUsd: number
}

export interface Candles {
  opens: number[]
  highs: number[]
  lows: number[]
  closes: number[]
  volumes: number[]
}

export interface Extras {
  openInterestUsd: number
  lsr: number
  fundingRate: number
  bid: number
  ask: number
}

const ENDPOINTS: Record<CexId, string> = {
  okx: process.env.OKX_API_BASE || "https://www.okx.com",
  binance: process.env.BINANCE_API_BASE || "https://fapi.binance.com",
  bybit: process.env.BYBIT_API_BASE || "https://api.bybit.com",
  bitget: process.env.BITGET_API_BASE || "https://api.bitget.com",
  gateio: process.env.GATEIO_API_BASE || "https://api.gateio.ws",
  mexc: process.env.MEXC_API_BASE || "https://contract.mexc.com",
}

function base(cex: CexId): string {
  return ENDPOINTS[cex].replace(/\/$/, "")
}

async function getJson(url: string, revalidate = 30): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, next: { revalidate } })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

function num(v: any): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ── Symbol helpers ────────────────────────────────────────────────────────────
function canon(b: string): string {
  return `${b.toUpperCase()}USDT`
}

// ════════════════════════════════════════════════════════════════════════════
// OKX
// ════════════════════════════════════════════════════════════════════════════
const okx = {
  async fetchTickers(): Promise<TickerLite[]> {
    const j = await getJson(`${base("okx")}/api/v5/market/tickers?instType=SWAP`)
    const data = j?.code === "0" ? j.data : null
    if (!Array.isArray(data)) return []
    const out: TickerLite[] = []
    for (const t of data) {
      const instId: string = t.instId || ""
      if (!instId.endsWith("-USDT-SWAP")) continue
      const b = instId.split("-")[0]
      const last = num(t.last)
      const open24h = num(t.open24h) || last
      out.push({
        symbol: canon(b),
        base: b.toUpperCase(),
        native: instId,
        last,
        pct24h: open24h ? ((last - open24h) / open24h) * 100 : 0,
        volUsd: num(t.volCcy24h) * last,
        oiUsd: 0,
      })
    }
    return out
  },
  async fetchCandles(native: string, limit = 100, tf: Timeframe = "1h"): Promise<Candles | null> {
    const j = await getJson(
      `${base("okx")}/api/v5/market/candles?instId=${native}&bar=${tfNative("okx", tf)}&limit=${limit}`,
      60,
    )
    const data = j?.code === "0" ? j.data : null
    if (!Array.isArray(data) || data.length === 0) return null
    const rows = [...data].reverse() // newest-first → chronological
    return mapRows(rows, 1, 2, 3, 4, 5)
  },
  async fetchExtras(b: string, native: string, price: number): Promise<Partial<Extras>> {
    const [oi, lsr, fr, books] = await Promise.all([
      getJson(`${base("okx")}/api/v5/public/open-interest?instType=SWAP&instId=${native}`),
      getJson(`${base("okx")}/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${b}&period=1H&limit=1`),
      getJson(`${base("okx")}/api/v5/public/funding-rate?instId=${native}`),
      getJson(`${base("okx")}/api/v5/market/books?instId=${native}&sz=25`),
    ])
    const oiUsd = oi?.data?.[0] ? num(oi.data[0].oiUsd) : 0
    const ratio = lsr?.data?.[0] ? num(lsr.data[0][1]) : 1
    const funding = fr?.data?.[0] ? num(fr.data[0].fundingRate) : 0
    const book = books?.data?.[0]
    const bid = book ? sumDepth(book.bids) : 0
    const ask = book ? sumDepth(book.asks) : 0
    return { openInterestUsd: oiUsd, lsr: ratio || 1, fundingRate: funding, bid, ask }
  },
}

// ════════════════════════════════════════════════════════════════════════════
// BINANCE (USDⓈ-M futures)
// ════════════════════════════════════════════════════════════════════════════
const binance = {
  async fetchTickers(): Promise<TickerLite[]> {
    const data = await getJson(`${base("binance")}/fapi/v1/ticker/24hr`)
    if (!Array.isArray(data)) return []
    const out: TickerLite[] = []
    for (const t of data) {
      const sym: string = t.symbol || ""
      if (!sym.endsWith("USDT")) continue
      const b = sym.slice(0, -4)
      out.push({
        symbol: sym.toUpperCase(),
        base: b.toUpperCase(),
        native: sym,
        last: num(t.lastPrice),
        pct24h: num(t.priceChangePercent),
        volUsd: num(t.quoteVolume),
        oiUsd: 0,
      })
    }
    return out
  },
  async fetchCandles(native: string, limit = 100, tf: Timeframe = "1h"): Promise<Candles | null> {
    const data = await getJson(
      `${base("binance")}/fapi/v1/klines?symbol=${native}&interval=${tfNative("binance", tf)}&limit=${limit}`,
      60,
    )
    if (!Array.isArray(data) || data.length === 0) return null
    return mapRows(data, 1, 2, 3, 4, 5)
  },
  async fetchExtras(b: string, native: string, price: number): Promise<Partial<Extras>> {
    const [oi, lsr, prem] = await Promise.all([
      getJson(`${base("binance")}/fapi/v1/openInterest?symbol=${native}`),
      getJson(`${base("binance")}/futures/data/globalLongShortAccountRatio?symbol=${native}&period=1h&limit=1`),
      getJson(`${base("binance")}/fapi/v1/premiumIndex?symbol=${native}`),
    ])
    const oiUsd = oi ? num(oi.openInterest) * price : 0
    const ratio = Array.isArray(lsr) && lsr[0] ? num(lsr[0].longShortRatio) : 1
    const funding = prem ? num(prem.lastFundingRate) : 0
    return { openInterestUsd: oiUsd, lsr: ratio || 1, fundingRate: funding }
  },
}

// ════════════════════════════════════════════════════════════════════════════
// BYBIT (v5 linear perps)
// ════════════════════════════════════════════════════════════════════════════
const bybit = {
  async fetchTickers(): Promise<TickerLite[]> {
    const j = await getJson(`${base("bybit")}/v5/market/tickers?category=linear`)
    const list = j?.result?.list
    if (!Array.isArray(list)) return []
    const out: TickerLite[] = []
    for (const t of list) {
      const sym: string = t.symbol || ""
      if (!sym.endsWith("USDT")) continue
      const b = sym.slice(0, -4)
      out.push({
        symbol: sym.toUpperCase(),
        base: b.toUpperCase(),
        native: sym,
        last: num(t.lastPrice),
        pct24h: num(t.price24hPcnt) * 100,
        volUsd: num(t.turnover24h),
        oiUsd: num(t.openInterestValue),
      })
    }
    return out
  },
  async fetchCandles(native: string, limit = 100, tf: Timeframe = "1h"): Promise<Candles | null> {
    const j = await getJson(
      `${base("bybit")}/v5/market/kline?category=linear&symbol=${native}&interval=${tfNative("bybit", tf)}&limit=${limit}`,
      60,
    )
    const list = j?.result?.list
    if (!Array.isArray(list) || list.length === 0) return null
    const rows = [...list].reverse() // newest-first → chronological
    return mapRows(rows, 1, 2, 3, 4, 5)
  },
  async fetchExtras(b: string, native: string, price: number): Promise<Partial<Extras>> {
    const [oi, lsr] = await Promise.all([
      getJson(`${base("bybit")}/v5/market/open-interest?category=linear&symbol=${native}&intervalTime=1h&limit=1`),
      getJson(`${base("bybit")}/v5/market/account-ratio?category=linear&symbol=${native}&period=1h&limit=1`),
    ])
    const oiBase = oi?.result?.list?.[0] ? num(oi.result.list[0].openInterest) : 0
    const ratio = lsr?.result?.list?.[0] ? num(lsr.result.list[0].buyRatio) / Math.max(1e-9, num(lsr.result.list[0].sellRatio)) : 1
    return { openInterestUsd: oiBase * price, lsr: ratio || 1 }
  },
}

// ════════════════════════════════════════════════════════════════════════════
// BITGET (v2 USDT-FUTURES)
// ════════════════════════════════════════════════════════════════════════════
const bitget = {
  async fetchTickers(): Promise<TickerLite[]> {
    const j = await getJson(`${base("bitget")}/api/v2/mix/market/tickers?productType=USDT-FUTURES`)
    const data = j?.data
    if (!Array.isArray(data)) return []
    const out: TickerLite[] = []
    for (const t of data) {
      const sym: string = t.symbol || ""
      if (!sym.endsWith("USDT")) continue
      const b = sym.slice(0, -4)
      const last = num(t.lastPr)
      out.push({
        symbol: sym.toUpperCase(),
        base: b.toUpperCase(),
        native: sym,
        last,
        pct24h: num(t.change24h) * 100,
        volUsd: num(t.usdtVolume) || num(t.baseVolume) * last,
        oiUsd: num(t.holdingAmount) * last,
      })
    }
    return out
  },
  async fetchCandles(native: string, limit = 100, tf: Timeframe = "1h"): Promise<Candles | null> {
    const data = (await getJson(
      `${base("bitget")}/api/v2/mix/market/candles?symbol=${native}&productType=USDT-FUTURES&granularity=${tfNative("bitget", tf)}&limit=${limit}`,
      60,
    ))?.data
    if (!Array.isArray(data) || data.length === 0) return null
    return mapRows(data, 1, 2, 3, 4, 5) // [ts,o,h,l,c,baseVol,quoteVol] chronological
  },
  async fetchExtras(b: string, native: string, price: number): Promise<Partial<Extras>> {
    const [oi, fr] = await Promise.all([
      getJson(`${base("bitget")}/api/v2/mix/market/open-interest?symbol=${native}&productType=USDT-FUTURES`),
      getJson(`${base("bitget")}/api/v2/mix/market/current-fund-rate?symbol=${native}&productType=USDT-FUTURES`),
    ])
    const oiBase = oi?.data?.openInterestList?.[0] ? num(oi.data.openInterestList[0].size) : num(oi?.data?.amount)
    const funding = fr?.data?.[0] ? num(fr.data[0].fundingRate) : 0
    return { openInterestUsd: (oiBase || 0) * price, fundingRate: funding }
  },
}

// ════════════════════════════════════════════════════════════════════════════
// GATE.IO (v4 USDT futures)
// ════════════════════════════════════════════════════════════════════════════
const gateio = {
  async fetchTickers(): Promise<TickerLite[]> {
    const data = await getJson(`${base("gateio")}/api/v4/futures/usdt/tickers`)
    if (!Array.isArray(data)) return []
    const out: TickerLite[] = []
    for (const t of data) {
      const contract: string = t.contract || ""
      if (!contract.endsWith("_USDT")) continue
      const b = contract.slice(0, -5)
      const last = num(t.last)
      out.push({
        symbol: canon(b),
        base: b.toUpperCase(),
        native: contract,
        last,
        pct24h: num(t.change_percentage),
        volUsd: num(t.volume_24h_settle) || num(t.volume_24h_quote),
        oiUsd: 0,
      })
    }
    return out
  },
  async fetchCandles(native: string, limit = 100, tf: Timeframe = "1h"): Promise<Candles | null> {
    const data = await getJson(
      `${base("gateio")}/api/v4/futures/usdt/candlesticks?contract=${native}&interval=${tfNative("gateio", tf)}&limit=${limit}`,
      60,
    )
    if (!Array.isArray(data) || data.length === 0) return null
    // Gate returns objects { t, v, c, h, l, o } in chronological order.
    const opens: number[] = []
    const highs: number[] = []
    const lows: number[] = []
    const closes: number[] = []
    const volumes: number[] = []
    for (const c of data) {
      opens.push(num(c.o))
      highs.push(num(c.h))
      lows.push(num(c.l))
      closes.push(num(c.c))
      volumes.push(num(c.v))
    }
    if (closes.every((n) => n === 0)) return null
    return { opens, highs, lows, closes, volumes }
  },
  async fetchExtras(b: string, native: string, price: number): Promise<Partial<Extras>> {
    const c = await getJson(`${base("gateio")}/api/v4/futures/usdt/contracts/${native}`)
    const funding = c ? num(c.funding_rate) : 0
    const oiBase = c ? num(c.position_size) : 0
    return { openInterestUsd: oiBase * price, fundingRate: funding }
  },
}

// ════════════════════════════════════════════════════════════════════════════
// MEXC (contract / perpetual)
// ════════════════════════════════════════════════════════════════════════════
const mexc = {
  async fetchTickers(): Promise<TickerLite[]> {
    const j = await getJson(`${base("mexc")}/api/v1/contract/ticker`)
    const data = j?.data
    if (!Array.isArray(data)) return []
    const out: TickerLite[] = []
    for (const t of data) {
      const sym: string = t.symbol || ""
      if (!sym.endsWith("_USDT")) continue
      const b = sym.slice(0, -5)
      const last = num(t.lastPrice)
      out.push({
        symbol: canon(b),
        base: b.toUpperCase(),
        native: sym,
        last,
        pct24h: num(t.riseFallRate) * 100,
        volUsd: num(t.amount24),
        oiUsd: num(t.holdVol) * last,
      })
    }
    return out
  },
  async fetchCandles(native: string, limit = 100, tf: Timeframe = "1h"): Promise<Candles | null> {
    const j = await getJson(`${base("mexc")}/api/v1/contract/kline/${native}?interval=${tfNative("mexc", tf)}`, 60)
    const d = j?.data
    if (!d || !Array.isArray(d.close) || d.close.length === 0) return null
    const take = (arr: any[]) => (Array.isArray(arr) ? arr.slice(-limit).map(num) : [])
    return {
      opens: take(d.open),
      highs: take(d.high),
      lows: take(d.low),
      closes: take(d.close),
      volumes: take(d.vol),
    }
  },
  async fetchExtras(b: string, native: string, price: number): Promise<Partial<Extras>> {
    const fr = await getJson(`${base("mexc")}/api/v1/contract/funding_rate/${native}`)
    const funding = fr?.data ? num(fr.data.fundingRate) : 0
    return { fundingRate: funding }
  },
}

// ── Shared row mapper for array-of-arrays candle payloads ──────────────────────
function mapRows(rows: any[], oi: number, hi: number, li: number, ci: number, vi: number): Candles {
  const opens: number[] = []
  const highs: number[] = []
  const lows: number[] = []
  const closes: number[] = []
  const volumes: number[] = []
  for (const r of rows) {
    opens.push(num(r[oi]))
    highs.push(num(r[hi]))
    lows.push(num(r[li]))
    closes.push(num(r[ci]))
    volumes.push(num(r[vi]))
  }
  return { opens, highs, lows, closes, volumes }
}

function sumDepth(levels: any): number {
  if (!Array.isArray(levels)) return 0
  return levels.reduce((a: number, l: any[]) => a + num(l[1]), 0)
}

export interface ExchangeAdapter {
  id: CexId
  fetchTickers(): Promise<TickerLite[]>
  fetchCandles(native: string, limit?: number, tf?: Timeframe): Promise<Candles | null>
  fetchExtras(b: string, native: string, price: number): Promise<Partial<Extras>>
}

const ADAPTERS: Record<CexId, ExchangeAdapter> = {
  okx: { id: "okx", ...okx },
  binance: { id: "binance", ...binance },
  bybit: { id: "bybit", ...bybit },
  bitget: { id: "bitget", ...bitget },
  gateio: { id: "gateio", ...gateio },
  mexc: { id: "mexc", ...mexc },
}

export function getExchange(cex: string | null | undefined): ExchangeAdapter {
  const id = (cex || "okx").toLowerCase() as CexId
  return ADAPTERS[id] ?? ADAPTERS.okx
}

// Run an async mapper over items with bounded concurrency and an optional wall-clock
// budget. Items not reached before the deadline are returned via `onSkip` so callers
// can degrade gracefully (e.g. lightweight ticker-only signal) instead of timing out.
export async function mapWithBudget<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  opts: { concurrency: number; budgetMs: number },
): Promise<{ results: Map<T, R>; reached: number }> {
  const results = new Map<T, R>()
  const deadline = Date.now() + opts.budgetMs
  let cursor = 0
  let reached = 0

  async function runner() {
    while (cursor < items.length && Date.now() < deadline) {
      const idx = cursor++
      const item = items[idx]
      try {
        const r = await worker(item)
        results.set(item, r)
        reached++
      } catch {
        /* skip failures */
      }
    }
  }

  const runners = Array.from({ length: Math.min(opts.concurrency, items.length) }, () => runner())
  await Promise.all(runners)
  return { results, reached }
}
