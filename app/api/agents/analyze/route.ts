import { NextResponse } from "next/server"
import { runAnalysisPipeline } from "@/lib/agents/pipeline"
import { getEvolutionState, processTradeResult, type TradeResult } from "@/lib/agents/self-evaluation"
import { agentRegistry } from "@/lib/agents/registry"
import { registerBuiltinAgents } from "@/lib/agents/builtin-agents"
import { EXPECTED_AGENT_COUNT } from "@/lib/agents/config"
import type { AgentInput, Candle, PipelineProgress } from "@/lib/agents/types"

export const dynamic = "force-dynamic"
export const revalidate = 0

let initialized = false
function ensureInit() {
  if (!initialized) {
    registerBuiltinAgents()
    initialized = true
  }
}

const OKX = (process.env.MARKET_API_BASE || "https://www.okx.com").replace(/\/$/, "")

async function okx(path: string): Promise<any | null> {
  try {
    const res = await fetch(OKX + path, { headers: { accept: "application/json" }, next: { revalidate: 15 } })
    if (!res.ok) return null
    const json = await res.json()
    if (json?.code !== "0") return null
    return json.data
  } catch {
    return null
  }
}

function baseOf(symbol: string): string {
  return symbol.replace(/USDT$/i, "").replace(/-.*/, "").toUpperCase()
}

// Build a full AgentInput from real OKX data. Fields the public feed cannot
// provide (sentiment, whale flow, liquidations, kimchi, usdt supply) default to 0
// so the data-dependent agents WAIT gracefully instead of failing.
async function buildAgentInput(symbol: string): Promise<AgentInput | null> {
  const base = baseOf(symbol)
  const instId = `${base}-USDT-SWAP`

  const [candleData, ticker, oiData, fundingData, lsrData, books] = await Promise.all([
    okx(`/api/v5/market/candles?instId=${instId}&bar=1H&limit=100`),
    okx(`/api/v5/market/ticker?instId=${instId}`),
    okx(`/api/v5/public/open-interest?instType=SWAP&instId=${instId}`),
    okx(`/api/v5/public/funding-rate?instId=${instId}`),
    okx(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${base}&period=1H&limit=1`),
    okx(`/api/v5/market/books?instId=${instId}&sz=25`),
  ])

  // OKX candles are newest-first [ts,o,h,l,c,vol,...]; reverse to chronological.
  const rows: string[][] = Array.isArray(candleData) ? [...candleData].reverse() : []
  const candles: Candle[] = rows
    .map((c) => ({
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      vol: Number(c[5]),
    }))
    .filter((c) => Number.isFinite(c.close) && Number.isFinite(c.open))

  if (candles.length === 0) return null

  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const volumes = candles.map((c) => c.vol)

  const t = Array.isArray(ticker) ? ticker[0] : null
  const price = Number(t?.last) || closes[closes.length - 1] || 0

  // OI in base units (agents multiply by price for USD notional).
  let openInterest = 0
  if (Array.isArray(oiData) && oiData[0]) {
    openInterest = Number(oiData[0].oiCcy) || (Number(oiData[0].oiUsd) || 0) / Math.max(1, price)
  }

  const fundingRate = Array.isArray(fundingData) && fundingData[0] ? Number(fundingData[0].fundingRate) || 0 : 0
  const lsr = Array.isArray(lsrData) && lsrData[0] ? Number(lsrData[0][1]) || 1 : 1

  // Order-book depth as bid/ask proxy for the game-theorist agent.
  let bid = 0
  let ask = 0
  const book = Array.isArray(books) ? books[0] : null
  if (book) {
    bid = (book.bids || []).reduce((a: number, b: string[]) => a + (Number(b[1]) || 0), 0)
    ask = (book.asks || []).reduce((a: number, b: string[]) => a + (Number(b[1]) || 0), 0)
  }

  const atr14 = wilderAtr(highs, lows, closes, 14)

  return {
    symbol,
    price,
    candles,
    closes,
    highs,
    lows,
    volumes,
    openInterest,
    lsr: Number.isFinite(lsr) ? lsr : 1,
    fundingRate,
    bid,
    ask,
    atr14,
    // Not available from public spot/perp feed → 0 (agents WAIT gracefully).
    sentimentScore: 0,
    newsCount: 0,
    whaleInflowUsd: 0,
    longLiq1h: 0,
    shortLiq1h: 0,
    usdtDeltaPct: 0,
    kimchiPct: 0,
    timestamp: Date.now(),
    tsMs: Date.now(),
  }
}

function wilderAtr(highs: number[], lows: number[], closes: number[], period: number): number {
  if (closes.length < 2) return 0
  const tr: number[] = []
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])))
  }
  const seedN = Math.min(period, tr.length)
  let atr = tr.slice(0, seedN).reduce((a, b) => a + b, 0) / seedN
  const alpha = 1 / period
  for (const v of tr.slice(seedN)) atr = atr * (1 - alpha) + v * alpha
  return atr
}

// GET /api/agents/analyze?symbol=BTCUSDT — run the full 13-agent pipeline.
export async function GET(request: Request) {
  ensureInit()
  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get("symbol") || "BTCUSDT"

  try {
    const input = await buildAgentInput(symbol)
    if (!input) {
      return NextResponse.json({
        ok: false,
        error: "Market data unavailable",
        progress: { stage: "error", currentStep: 0, totalSteps: 6, message: "Market data unavailable" },
      })
    }

    let latestProgress: PipelineProgress | null = null
    const result = await runAnalysisPipeline(input, (p) => {
      latestProgress = p
    })

    const evolution = getEvolutionState()

    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      symbol: input.symbol,
      consensus: result.consensus,
      agentOutputs: result.agentOutputs,
      progress: result.progress,
      // Execution accounting — surfaces exactly how many agents ran vs. expected.
      executedAgents: result.executedAgents,
      expectedAgents: result.expectedAgents,
      warnings: result.warnings,
      evolution: {
        version: evolution.version,
        agentCount: Object.keys(evolution.agents).length,
        team: evolution.team,
        recentReports: evolution.reports.slice(-10),
      },
      agents: agentRegistry.getEnabledAgents().map((a) => ({
        id: a.id,
        name: a.name,
        category: a.category,
        weight: a.weight,
        enabled: a.enabled,
      })),
    })
  } catch (err) {
    console.error("[/api/agents/analyze] Error:", err)
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
      expectedAgents: EXPECTED_AGENT_COUNT,
      progress: { stage: "error", currentStep: 0, totalSteps: 6, message: "Pipeline failed" },
    })
  }
}

// POST /api/agents/analyze — submit a trade result to trigger self-evaluation.
export async function POST(request: Request) {
  ensureInit()
  try {
    const body = (await request.json()) as TradeResult
    if (!body.direction || body.pnlR === undefined || !body.agentVotes) {
      return NextResponse.json(
        { ok: false, error: "Missing required fields: direction, pnlR, agentVotes" },
        { status: 400 },
      )
    }
    const reports = processTradeResult(body)
    const evolution = getEvolutionState()
    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      reportsGenerated: reports.length,
      reports,
      evolution: { version: evolution.version, team: evolution.team, agents: evolution.agents },
    })
  } catch (err) {
    console.error("[/api/agents/analyze POST] Error:", err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    )
  }
}
