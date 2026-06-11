import { NextResponse } from "next/server"
import { runAnalysisPipeline } from "@/lib/agents/pipeline"
import { getEvolutionState, processTradeResult, type TradeResult } from "@/lib/agents/self-evaluation"
import { agentRegistry } from "@/lib/agents/registry"
import { registerBuiltinAgents } from "@/lib/agents/builtin-agents"
import { EXPECTED_AGENT_COUNT } from "@/lib/agents/config"
import type { AgentInput, Candle, PipelineProgress } from "@/lib/agents/types"
import { getExchange } from "@/lib/exchanges"

export const dynamic = "force-dynamic"
export const revalidate = 0

let initialized = false
function ensureInit() {
  if (!initialized) {
    registerBuiltinAgents()
    initialized = true
  }
}

function baseOf(symbol: string): string {
  return symbol.replace(/USDT$/i, "").replace(/[-_].*/, "").toUpperCase()
}

// Build a full AgentInput from real data on the ACTIVE exchange. Fields the public
// feed cannot provide (sentiment, news, liquidations, kimchi, usdt supply) default
// to 0 so those data-dependent agents WAIT gracefully instead of failing.
async function buildAgentInput(symbol: string, cexId: string): Promise<AgentInput | null> {
  const base = baseOf(symbol)
  let ex = getExchange(cexId)

  // Resolve the exchange-native instrument id for this canonical symbol.
  let tickers = await ex.fetchTickers()
  
  // MULTI-API FALLBACK: If active CEX fails, seamlessly hop to OKX or Bybit
  if (tickers.length === 0) {
    ex = getExchange("okx")
    tickers = await ex.fetchTickers()
    if (tickers.length === 0) {
      ex = getExchange("bybit")
      tickers = await ex.fetchTickers()
    }
  }

  const ticker = tickers.find((t) => t.symbol.toUpperCase() === symbol.toUpperCase() || t.base === base)
  const native = ticker?.native ?? symbol

  const [candleData, extras] = await Promise.all([
    ex.fetchCandles(native, 100),
    ex.fetchExtras(base, native, ticker?.last ?? 0),
  ])

  if (!candleData || candleData.closes.length === 0) return null

  const { opens, highs, lows, closes, volumes } = candleData
  const candles: Candle[] = closes
    .map((close, i) => ({ open: opens[i], high: highs[i], low: lows[i], close, vol: volumes[i] }))
    .filter((c) => Number.isFinite(c.close) && Number.isFinite(c.open))

  if (candles.length === 0) return null

  const price = ticker?.last || closes[closes.length - 1] || 0

  // OI in base units (agents multiply by price for USD notional).
  const oiUsd = extras.openInterestUsd ?? (ticker?.oiUsd || 0)
  const openInterest = price > 0 ? oiUsd / price : 0
  const fundingRate = extras.fundingRate ?? 0
  const lsr = extras.lsr ?? 1
  const bid = extras.bid ?? 0
  const ask = extras.ask ?? 0

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
  const cexId = searchParams.get("cex") || "okx"

  try {
    const input = await buildAgentInput(symbol, cexId)
    if (!input) {
      return NextResponse.json({
        ok: false,
        error: "Market data unavailable",
        progress: { stage: "error", currentStep: 0, totalSteps: 6, message: "Market data unavailable" },
      }, { status: 502 })
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
        agents: evolution.agents,
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
    }, { status: 500 })
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
