"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import type { Consensus, MarketResponse, MarketRow, Snapshot } from "@/lib/types"
import { pollEngine, startEngine, stopEngine, type EngineSnapshot } from "@/lib/engine"
import { localStore } from "@/lib/local-store"
import { runLocalBacktest, type BacktestResult } from "@/lib/backtest"
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
  activity?: string
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
  decision: "VOTED" | "VETO"
  signal: "LONG" | "SHORT" | "WAIT" | "VETO"
  confidence: number
  votes: { long: number; short: number; hold: number; veto: number }
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

// ---- Mode & exchange configuration -------------------------------------

// Supported centralized exchanges.
export type CexId = "mexc" | "binance" | "bybit" | "bitget" | "gateio" | "okx"
export type TradingStyle = "scalp" | "intraday" | "swing"
export type MarginMode = "isolated" | "cross"

// ---- Flexible (preset-based) risk model ---------------------------------
// No free-form numeric input: every metric is chosen from a controlled set of
// safe options, so the user can flex the risk profile without breaking config.
export type RiskPreset = "conservative" | "balanced" | "aggressive"

export interface RiskModel {
  /** High-level baseline. Selecting it snaps every metric to a safe combo. */
  preset: RiskPreset
  /** ATR multiplier used for stop-loss distance. */
  atrMultiplier: number
  /** Risk : reward ratio (reward side). */
  riskReward: number
  /** Target ROI per position (%). */
  targetRoiPct: number
  /** Max PnL risked per trade (%) — this also drives risk-per-trade sizing. */
  maxPnlPct: number
}

// Controlled option sets — the only values a user can pick from.
export const RISK_OPTIONS = {
  atrMultiplier: [1, 1.5, 2, 2.5, 3],
  riskReward: [1.5, 2, 2.5, 3],
  targetRoiPct: [5, 10, 20, 50],
  maxPnlPct: [0.5, 1, 2, 3, 5],
} as const

export const RISK_PRESETS: Record<RiskPreset, RiskModel> = {
  conservative: { preset: "conservative", atrMultiplier: 2.5, riskReward: 3, targetRoiPct: 5, maxPnlPct: 0.5 },
  balanced: { preset: "balanced", atrMultiplier: 2, riskReward: 2, targetRoiPct: 10, maxPnlPct: 1 },
  aggressive: { preset: "aggressive", atrMultiplier: 1.5, riskReward: 1.5, targetRoiPct: 20, maxPnlPct: 3 },
}

export interface PairLeverage {
  pair: string
  leverage: number
}

export interface CexConfig {
  id: CexId
  label: string
  enabled: boolean
  /** Names of the env vars that hold this exchange's credentials. */
  apiKeyEnv: string
  apiSecretEnv: string
  passphraseEnv?: string
  marginMode: MarginMode
  /** Percentage of available balance committed as margin (0-100). */
  marginUsagePct: number
  /** Fallback leverage applied to any pair without a specific override. */
  defaultLeverage: number
  /** Flexible per-pair leverage overrides for this exchange. */
  pairLeverage: PairLeverage[]
}

export interface TradingSettings {
  activeCex: CexId
  tradingStyle: TradingStyle
  riskModel: RiskModel
  cexes: CexConfig[]
}

const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  activeCex: "mexc",
  tradingStyle: "intraday",
  riskModel: RISK_PRESETS.balanced,
  cexes: [
    {
      id: "mexc",
      label: "MEXC",
      enabled: true,
      apiKeyEnv: "MEXC_API_KEY",
      apiSecretEnv: "MEXC_API_SECRET",
      marginMode: "cross",
      marginUsagePct: 10,
      defaultLeverage: 5,
      pairLeverage: [
        { pair: "BTCUSDT", leverage: 10 },
        { pair: "ETHUSDT", leverage: 8 },
      ],
    },
    {
      id: "binance",
      label: "Binance",
      enabled: false,
      apiKeyEnv: "BINANCE_API_KEY",
      apiSecretEnv: "BINANCE_API_SECRET",
      marginMode: "cross",
      marginUsagePct: 10,
      defaultLeverage: 5,
      pairLeverage: [],
    },
    {
      id: "bybit",
      label: "Bybit",
      enabled: false,
      apiKeyEnv: "BYBIT_API_KEY",
      apiSecretEnv: "BYBIT_API_SECRET",
      marginMode: "cross",
      marginUsagePct: 10,
      defaultLeverage: 5,
      pairLeverage: [],
    },
    {
      id: "bitget",
      label: "Bitget",
      enabled: false,
      apiKeyEnv: "BITGET_API_KEY",
      apiSecretEnv: "BITGET_API_SECRET",
      passphraseEnv: "BITGET_API_PASSPHRASE",
      marginMode: "cross",
      marginUsagePct: 10,
      defaultLeverage: 5,
      pairLeverage: [],
    },
    {
      id: "gateio",
      label: "Gate.io",
      enabled: false,
      apiKeyEnv: "GATEIO_API_KEY",
      apiSecretEnv: "GATEIO_API_SECRET",
      marginMode: "cross",
      marginUsagePct: 10,
      defaultLeverage: 5,
      pairLeverage: [],
    },
    {
      id: "okx",
      label: "OKX",
      enabled: false,
      apiKeyEnv: "OKX_API_KEY",
      apiSecretEnv: "OKX_API_SECRET",
      passphraseEnv: "OKX_API_PASSPHRASE",
      marginMode: "cross",
      marginUsagePct: 10,
      defaultLeverage: 5,
      pairLeverage: [],
    },
  ],
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

// A live forecast the agents are watching. When price crosses TP or SL we grade it
// and feed the result back so each agent self-adjusts (TP/SL-driven learning).
export interface PendingForecast {
  symbol: string
  direction: "LONG" | "SHORT"
  entry: number
  tp: number
  sl: number
  agentVotes: AgentOutput[]
  createdTs: number
}

// Submit a graded trade outcome to the self-evaluation engine.
async function postTradeResult(body: {
  symbol: string
  direction: "LONG" | "SHORT"
  pnlR: number
  isWin: boolean
  agentVotes: AgentOutput[]
}): Promise<void> {
  try {
    await fetch("/api/agents/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  } catch {
    /* best-effort; learning will retry on the next resolved forecast */
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

  // Autonomous TP/SL learning: track the live forecast the agents are grading.
  const [pendingForecast, setPendingForecast] = useState<PendingForecast | null>(null)
  const [lastGrade, setLastGrade] = useState<{ symbol: string; isWin: boolean; pnlR: number; ts: number } | null>(null)
  const lastForecastTsRef = useRef(0)
  const resolvingRef = useRef(false)

  // Mode & exchange configuration (mode/settings tab)
  const [tradingSettings, setTradingSettings] = useState<TradingSettings>(DEFAULT_TRADING_SETTINGS)

  // Per-user (per-browser) local persistence + manual backtest results.
  const [hydrated, setHydrated] = useState(false)
  const [backtests, setBacktests] = useState<BacktestResult[]>([])
  const [isBacktesting, setIsBacktesting] = useState(false)

  // Load persisted state AFTER mount so server/client first render match
  // (avoids hydration mismatches). Defaults render first, then we swap in
  // whatever this browser previously saved.
  useEffect(() => {
    const savedSettings = localStore.loadTradingSettings()
    if (savedSettings) {
      // Merge in any default CEXes the saved config predates (keeps the user's
      // per-exchange tweaks while still exposing newly-added exchanges).
      const savedById = new Map(savedSettings.cexes.map((c) => [c.id, c]))
      const mergedCexes = DEFAULT_TRADING_SETTINGS.cexes.map((def) => ({
        ...def,
        ...savedById.get(def.id),
      }))
      // Preserve any saved CEX that is no longer in defaults, just in case.
      for (const c of savedSettings.cexes) {
        if (!mergedCexes.some((m) => m.id === c.id)) mergedCexes.push(c)
      }
      // Backfill the flexible risk model for configs saved before it existed.
      setTradingSettings({
        ...savedSettings,
        cexes: mergedCexes,
        riskModel: savedSettings.riskModel ?? RISK_PRESETS.balanced,
      })
    }
    const savedDryRun = localStore.loadDryRun()
    if (savedDryRun) setDryRunConfig(savedDryRun)
    setBacktests(localStore.loadBacktests())
    setHydrated(true)
  }, [])

  // Persist settings + mode whenever they change (only after initial hydration).
  useEffect(() => {
    if (hydrated) localStore.saveTradingSettings(tradingSettings)
  }, [hydrated, tradingSettings])

  useEffect(() => {
    if (hydrated) localStore.saveDryRun(dryRunConfig)
  }, [hydrated, dryRunConfig])
  
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

  // ── Open a forecast whenever the team produces a fresh VOTED long/short verdict.
  // We never overwrite an unresolved forecast — agents must see the outcome first.
  useEffect(() => {
    const a = agentAnalysis.data
    if (!a?.ok || !a.consensus) return
    if (a.ts === lastForecastTsRef.current) return
    const c = a.consensus
    const directional = c.signal === "LONG" || c.signal === "SHORT"
    if (c.decision === "VOTED" && directional && c.entry > 0 && c.tp > 0 && c.sl > 0) {
      lastForecastTsRef.current = a.ts
      setPendingForecast((prev) =>
        prev
          ? prev
          : {
              symbol: a.symbol,
              direction: c.signal as "LONG" | "SHORT",
              entry: c.entry,
              tp: c.tp,
              sl: c.sl,
              agentVotes: a.agentOutputs,
              createdTs: a.ts,
            },
      )
    }
  }, [agentAnalysis.data])

  // ── Grade the open forecast against the live price (TP vs SL). On resolution we
  // POST the result so every agent self-adjusts its weight/conviction autonomously.
  useEffect(() => {
    if (!pendingForecast || resolvingRef.current) return
    const row = (market.data?.market ?? []).find((m) => m.symbol === pendingForecast.symbol)
    const price = row?.lastPrice
    if (!price || price <= 0) return

    const { direction, entry, tp, sl, agentVotes, symbol } = pendingForecast
    const risk = Math.abs(entry - sl)
    const reward = Math.abs(tp - entry)
    const rr = risk > 1e-9 ? reward / risk : 1

    let resolved: { isWin: boolean; pnlR: number } | null = null
    if (direction === "LONG") {
      if (price >= tp) resolved = { isWin: true, pnlR: rr }
      else if (price <= sl) resolved = { isWin: false, pnlR: -1 }
    } else {
      if (price <= tp) resolved = { isWin: true, pnlR: rr }
      else if (price >= sl) resolved = { isWin: false, pnlR: -1 }
    }
    if (!resolved) return

    resolvingRef.current = true
    const outcome = resolved
    postTradeResult({ symbol, direction, pnlR: outcome.pnlR, isWin: outcome.isWin, agentVotes }).finally(() => {
      setLastGrade({ symbol, isWin: outcome.isWin, pnlR: outcome.pnlR, ts: Date.now() })
      setPendingForecast(null)
      resolvingRef.current = false
      // Pull the updated evolution stats back into the UI.
      agentAnalysis.mutate()
    })
  }, [market.data, pendingForecast, agentAnalysis])

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

  const updateTradingSettings = useCallback((patch: Partial<TradingSettings>) => {
    setTradingSettings(prev => ({ ...prev, ...patch }))
  }, [])

  // Flexible risk model. Any change re-derives risk-per-trade sizing from the
  // selected max-PnL metric so the dry-run engine stays in sync — no manual
  // numeric entry, so the config can't be put into an unsafe state.
  const updateRiskModel = useCallback((patch: Partial<RiskModel>) => {
    setTradingSettings(prev => {
      const nextModel = { ...prev.riskModel, ...patch }
      setDryRunConfig(cfg => ({ ...cfg, riskPerTrade: nextModel.maxPnlPct / 100 }))
      return { ...prev, riskModel: nextModel }
    })
  }, [])

  const applyRiskPreset = useCallback((preset: RiskPreset) => {
    const model = RISK_PRESETS[preset]
    setTradingSettings(prev => ({ ...prev, riskModel: model }))
    setDryRunConfig(cfg => ({ ...cfg, riskPerTrade: model.maxPnlPct / 100 }))
  }, [])

  // Patch a single exchange's config by id.
  const updateCexConfig = useCallback((id: CexId, patch: Partial<CexConfig>) => {
    setTradingSettings(prev => ({
      ...prev,
      cexes: prev.cexes.map(cex => (cex.id === id ? { ...cex, ...patch } : cex)),
    }))
  }, [])

  // Manual, per-user backtest. Triggered explicitly by the user (never auto-run);
  // computed locally from the current config and saved to this browser only.
  const runBacktest = useCallback(async () => {
    setIsBacktesting(true)
    try {
      // Small async yield so the UI can show the running state.
      await new Promise(r => setTimeout(r, 400))
      const result = runLocalBacktest(tradingSettings, dryRunConfig, snapshot.market)
      setBacktests(prev => {
        const next = [result, ...prev].slice(0, 20) // keep last 20 per user
        localStore.saveBacktests(next)
        return next
      })
      return result
    } finally {
      setIsBacktesting(false)
    }
  }, [tradingSettings, dryRunConfig, snapshot.market])

  const clearBacktests = useCallback(() => {
    setBacktests([])
    localStore.clearBacktests()
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

    // Autonomous TP/SL learning loop
    pendingForecast,
    lastGrade,
    
    // Dry-run mode
    dryRunConfig,
    toggleDryRun,
    updateDryRunConfig,

    // Mode & exchange settings
    tradingSettings,
    updateTradingSettings,
    updateCexConfig,
    updateRiskModel,
    applyRiskPreset,

    // Local-first persistence + manual backtest
    hydrated,
    backtests,
    isBacktesting,
    runBacktest,
    clearBacktests,
  }
}

export { EMPTY_PERF, EMPTY_RISK }
