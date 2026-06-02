"use client"

import { useCallback, useMemo, useState } from "react"
import useSWR from "swr"
import type { Consensus, MarketResponse, MarketRow, Snapshot } from "@/lib/types"
import { pollEngine, startEngine, stopEngine, type EngineSnapshot } from "@/lib/engine"
import {
  buildConsensus,
  buildPerformance,
  buildPositions,
  buildRisk,
  mapLogs,
  mapSignal,
  parseConfidence,
} from "@/lib/derive"

// Agent analysis types
export interface AgentOutput {
  agentId: string
  vote: "LONG" | "SHORT" | "WAIT" | "VETO"
  confidence: number
  reasoning: string
  metrics: Record<string, number>
}

export interface AgentInfo {
  id: string
  name: string
  category: string
  weight: number
  enabled: boolean
}

export interface PipelineProgress {
  stage: string
  currentStep: number
  totalSteps: number
  agentsCompleted: number
  totalAgents: number
  message: string
  startedAt: number
  completedAt?: number
  error?: string
}

export interface TeamConsensus {
  signal: "LONG" | "SHORT" | "WAIT" | "VETO"
  confidence: number
  agreeingAgents: string[]
  dissentingAgents: string[]
  vetoAgents: string[]
  reasoning: string
  entry: number
  tp: number
  sl: number
}

export interface EvolutionData {
  version: number
  agentCount: number
  team?: {
    trades: number
    wins: number
    losses: number
    netPnlR: number
    peakR: number
    drawdownR: number
    winStreak: number
    lossStreak: number
    conservatismBias: number
  }
  agents?: Record<string, {
    tunables: { weight: number; convictionScale: number; activationGate: number }
    scorecard: {
      trades: number
      correct: number
      incorrect: number
      accuracy: number
      recentAccuracy: number
      pnlContrib: number
      wrongStreak: number
    }
  }>
  recentReports?: any[]
}

export interface AgentAnalysisResponse {
  ok: boolean
  ts: number
  symbol: string
  consensus: TeamConsensus
  agentOutputs: AgentOutput[]
  progress: PipelineProgress
  evolution: EvolutionData
  agents: AgentInfo[]
  error?: string
}

export interface DryRunConfig {
  enabled: boolean
  initialBalance: number
  riskPerTrade: number // As decimal (0.02 = 2%)
}

const EMPTY_PERF = buildPerformance([], 0)
const EMPTY_RISK = buildRisk(null, [], EMPTY_PERF)

async function marketFetcher(): Promise<MarketResponse> {
  const res = await fetch("/api/market", { cache: "no-store" })
  if (!res.ok) return { ok: false, ts: Date.now(), market: [], consensus: null }
  return (await res.json()) as MarketResponse
}

async function agentAnalysisFetcher(symbol: string): Promise<AgentAnalysisResponse | null> {
  try {
    const res = await fetch(`/api/agents/analyze?symbol=${encodeURIComponent(symbol)}`, { 
      cache: "no-store" 
    })
    if (!res.ok) return null
    return (await res.json()) as AgentAnalysisResponse
  } catch {
    return null
  }
}

export function useLiveData() {
  // Dry-run mode state
  const [dryRunConfig, setDryRunConfig] = useState<DryRunConfig>({
    enabled: true, // Default to dry-run for safety
    initialBalance: 10000,
    riskPerTrade: 0.02
  })
  
  // Track analysis state
  const [analysisSymbol, setAnalysisSymbol] = useState("BTCUSDT")
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  
  // Real public market data + server-computed analytics (works on localhost + Vercel).
  const market = useSWR("market", marketFetcher, {
    refreshInterval: 15000,
    keepPreviousData: true,
  })

  // Real engine state via the local/remote Go gateway (live trading account).
  const engine = useSWR<EngineSnapshot>("engine", pollEngine, {
    refreshInterval: 3000,
    keepPreviousData: true,
  })
  
  // Agent analysis with progress tracking
  const agentAnalysis = useSWR<AgentAnalysisResponse | null>(
    `agent-analysis-${analysisSymbol}`,
    () => agentAnalysisFetcher(analysisSymbol),
    {
      refreshInterval: 30000, // Refresh every 30s
      keepPreviousData: true,
      onSuccess: () => setIsAnalyzing(false),
      onError: () => setIsAnalyzing(false),
    }
  )

  const snapshot = useMemo<Snapshot>(() => {
    const eng = engine.data
    const rows = market.data?.market ?? []
    const marketOnline = !!market.data?.ok && rows.length > 0
    const analyticsConsensus: Consensus | null = market.data?.consensus ?? null

    const online = !!eng?.online
    const insight = eng?.insight ?? null
    const engineConsensus = buildConsensus(insight)

    // When the engine is live it owns the verdict; otherwise the terminal runs
    // on the genuine analytics computed from real market data.
    const consensus: Consensus | null = engineConsensus ?? analyticsConsensus
    const activeSymbol = consensus?.symbol ?? ""

    // Overlay the engine's live verdict onto its active symbol row (real account
    // signal). All other rows keep their own computed TA signal.
    const marketRows: MarketRow[] = rows.map((m) => {
      if (online && insight && m.symbol === insight.symbol) {
        return {
          ...m,
          signalStatus: mapSignal(insight.signal_status),
          confidence: parseConfidence(insight.advice) || m.confidence,
        }
      }
      return m
    })

    const positions = buildPositions(eng?.active ?? [], marketRows)
    const performance = buildPerformance(eng?.history ?? [], insight?.balance ?? 0)
    
    // Include dry-run info in risk metrics
    const baseRisk = buildRisk(insight, positions, performance)
    const risk = {
      ...baseRisk,
      dryRun: dryRunConfig.enabled,
      balance: dryRunConfig.enabled ? dryRunConfig.initialBalance : baseRisk.balance,
      equity: dryRunConfig.enabled ? dryRunConfig.initialBalance : baseRisk.equity,
    }
    
    const log = mapLogs(eng?.logs ?? [])

    return {
      mode: eng?.running ? "RUNNING" : "STOPPED",
      engineOnline: online,
      activeSymbol,
      uptimeSec: 0,
      cycle: log.length,
      latencyMs: 0,
      marketOnline,
      market: marketRows,
      consensus,
      positions,
      risk,
      performance,
      log,
    }
  }, [engine.data, market.data, dryRunConfig])

  const start = useCallback(async () => {
    try {
      await startEngine()
    } finally {
      engine.mutate()
    }
  }, [engine])

  const stop = useCallback(async () => {
    try {
      await stopEngine()
    } finally {
      engine.mutate()
    }
  }, [engine])

  const refresh = useCallback(() => {
    engine.mutate()
    market.mutate()
    agentAnalysis.mutate()
  }, [engine, market, agentAnalysis])
  
  const runAnalysis = useCallback(async (symbol?: string) => {
    const targetSymbol = symbol || analysisSymbol
    setAnalysisSymbol(targetSymbol)
    setIsAnalyzing(true)
    await agentAnalysis.mutate()
  }, [analysisSymbol, agentAnalysis])
  
  const toggleDryRun = useCallback((enabled?: boolean) => {
    setDryRunConfig(prev => ({
      ...prev,
      enabled: enabled ?? !prev.enabled
    }))
  }, [])
  
  const updateDryRunConfig = useCallback((config: Partial<DryRunConfig>) => {
    setDryRunConfig(prev => ({ ...prev, ...config }))
  }, [])

  return {
    snapshot,
    start,
    stop,
    refresh,
    loadingMarket: market.isLoading,
    loadingEngine: engine.isLoading,
    
    // Agent analysis
    agentAnalysis: agentAnalysis.data,
    isAnalyzing: isAnalyzing || agentAnalysis.isLoading,
    analysisSymbol,
    runAnalysis,
    
    // Dry-run mode
    dryRunConfig,
    toggleDryRun,
    updateDryRunConfig,
  }
}

export { EMPTY_PERF, EMPTY_RISK }
