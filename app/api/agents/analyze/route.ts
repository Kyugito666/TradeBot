import { NextResponse } from "next/server"
import { runAnalysisPipeline, type PipelineResult } from "@/lib/agents/pipeline"
import { getEvolutionState, processTradeResult, type TradeResult } from "@/lib/agents/self-evaluation"
import { agentRegistry } from "@/lib/agents/registry"
import { registerBuiltinAgents } from "@/lib/agents/builtin-agents"
import type { AgentInput, PipelineProgress } from "@/lib/agents/types"

export const dynamic = "force-dynamic"
export const revalidate = 0

// Ensure agents are registered
let initialized = false
function ensureInit() {
  if (!initialized) {
    registerBuiltinAgents()
    initialized = true
  }
}

// GET /api/agents/analyze - Run analysis pipeline
export async function GET(request: Request) {
  ensureInit()
  
  const { searchParams } = new URL(request.url)
  const symbol = searchParams.get("symbol") || "BTCUSDT"
  
  try {
    // Fetch market data from our market API
    const marketRes = await fetch(new URL("/api/market", request.url).toString())
    const marketData = await marketRes.json()
    
    if (!marketData.ok || !marketData.market?.length) {
      return NextResponse.json({
        ok: false,
        error: "Market data unavailable",
        progress: { stage: "error", currentStep: 0, totalSteps: 6, message: "Market data unavailable" }
      })
    }
    
    // Find the requested symbol
    const row = marketData.market.find((m: any) => m.symbol === symbol) || marketData.market[0]
    
    // Build agent input
    const input: AgentInput = {
      symbol: row.symbol,
      closes: row.spark || [],
      highs: row.spark?.map((p: number) => p * 1.005) || [], // Approximate
      lows: row.spark?.map((p: number) => p * 0.995) || [],  // Approximate
      volumes: [],
      openInterest: row.openInterest || 0,
      lsr: row.lsrVal || 1,
      timestamp: Date.now()
    }
    
    // Run pipeline with progress tracking
    let latestProgress: PipelineProgress | null = null
    
    const result = await runAnalysisPipeline(input, (progress) => {
      latestProgress = progress
    })
    
    // Get evolution state
    const evolution = getEvolutionState()
    
    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      symbol: input.symbol,
      consensus: result.consensus,
      agentOutputs: result.agentOutputs,
      progress: result.progress,
      evolution: {
        version: evolution.version,
        agentCount: Object.keys(evolution.agents).length,
        team: evolution.team,
        recentReports: evolution.reports.slice(-10)
      },
      agents: agentRegistry.getEnabledAgents().map(a => ({
        id: a.id,
        name: a.name,
        category: a.category,
        weight: a.weight,
        enabled: a.enabled
      }))
    })
    
  } catch (err) {
    console.error("[/api/agents/analyze] Error:", err)
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
      progress: { stage: "error", currentStep: 0, totalSteps: 6, message: "Pipeline failed" }
    })
  }
}

// POST /api/agents/analyze - Submit trade result for self-evaluation
export async function POST(request: Request) {
  ensureInit()
  
  try {
    const body = await request.json() as TradeResult
    
    if (!body.direction || body.pnlR === undefined || !body.agentVotes) {
      return NextResponse.json({
        ok: false,
        error: "Missing required fields: direction, pnlR, agentVotes"
      }, { status: 400 })
    }
    
    const reports = processTradeResult(body)
    const evolution = getEvolutionState()
    
    return NextResponse.json({
      ok: true,
      ts: Date.now(),
      reportsGenerated: reports.length,
      reports,
      evolution: {
        version: evolution.version,
        team: evolution.team,
        agents: evolution.agents
      }
    })
    
  } catch (err) {
    console.error("[/api/agents/analyze POST] Error:", err)
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error"
    }, { status: 500 })
  }
}
