"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import type { Consensus, MarketResponse, MarketRow, Snapshot } from "@/lib/types"
import { pollEngine, startEngine, stopEngine, type EngineSnapshot } from "@/lib/engine"
import { localStore } from "@/lib/local-store"
import type { BacktestResult, PairStat } from "@/lib/backtest"
import type { Timeframe } from "@/lib/exchanges"
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
  compounding: boolean
}

// Options passed when the user runs a backtest from the Backtest tab. They scope
// the run to a candle timeframe + lookback period and a focused pair.
export interface BacktestRunOptions {
  /** Candle timeframe (15m / 1h / 4h / 1d). */
  timeframe?: Timeframe
  /** Lookback window in days that determines how much history is replayed. */
  periodDays?: number
  /** Pair to focus the replay chart on (defaults to the app's selected pair). */
  focusSymbol?: string
  /** If true, only backtest the focusSymbol instead of the entire market. */
  singlePairOnly?: boolean
}

// Re-export so UI components can type their timeframe state without reaching
// into the exchange layer directly.
export type { Timeframe }

// ---- Mode & exchange configuration -------------------------------------

// Supported centralized exchanges.
export type CexId = "mexc" | "binance" | "bybit" | "bitget" | "gateio" | "okx"
export type TradingStyle = "scalp" | "intraday" | "swing" | "momentum_burst" | "mean_reversion" | "trend_following"
export type MarginMode = "isolated" | "cross"

// ---- Flexible (preset-based) risk model ---------------------------------
// No free-form numeric input: every metric is chosen from a controlled set of
// safe options, so the user can flex the risk profile without breaking config.
export type RiskPreset = "conservative" | "balanced" | "aggressive" | "custom_detailed" | "custom_auto"

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
  atrMultiplier: [1, 1.2, 1.5, 1.8, 2, 2.5, 3, 3.5],
  riskReward: [1.2, 1.5, 2, 2.5, 3, 4, 5],
  targetRoiPct: [3, 5, 8, 10, 15, 20, 50, 100],
  maxPnlPct: [0.1, 0.5, 1, 2, 3, 5, 8, 10],
} as const

export const RISK_PRESETS: Record<RiskPreset, RiskModel> = {
  conservative: { preset: "conservative", atrMultiplier: 2.5, riskReward: 3, targetRoiPct: 5, maxPnlPct: 0.5 },
  balanced: { preset: "balanced", atrMultiplier: 2, riskReward: 2, targetRoiPct: 10, maxPnlPct: 1 },
  aggressive: { preset: "aggressive", atrMultiplier: 1.5, riskReward: 1.5, targetRoiPct: 20, maxPnlPct: 3 },
  custom_detailed: { preset: "custom_detailed", atrMultiplier: 2, riskReward: 2, targetRoiPct: 10, maxPnlPct: 1 },
  custom_auto: { preset: "custom_auto", atrMultiplier: 1.8, riskReward: 2.5, targetRoiPct: 15, maxPnlPct: 2 },
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
  selectedSymbol: string
}

const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  activeCex: "mexc",
  tradingStyle: "intraday",
  selectedSymbol: "BTCUSDT",
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

async function marketFetcher(cex: string): Promise<MarketResponse> {
  const res = await fetch(`/api/market?cex=${encodeURIComponent(cex)}`, { cache: "no-store" })
  if (!res.ok) throw new Error(`Market fetch failed: ${res.status}`)
  return (await res.json()) as MarketResponse
}

async function agentAnalysisFetcher(symbol: string, cex: string): Promise<AgentAnalysisResponse | null> {
  const res = await fetch(`/api/agents/analyze?symbol=${encodeURIComponent(symbol)}&cex=${encodeURIComponent(cex)}`, {
    cache: "no-store",
  })
  if (!res.ok) throw new Error(`Agent fetch failed: ${res.status}`)
  return (await res.json()) as AgentAnalysisResponse
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
    enabled: true,
    initialBalance: 10,
    riskPerTrade: 0.02,
    compounding: true,
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
  const [realSettings, setRealSettings] = useState<TradingSettings>(DEFAULT_TRADING_SETTINGS)
  const [drySettings, setDrySettings] = useState<TradingSettings>(DEFAULT_TRADING_SETTINGS)

  const tradingSettings = dryRunConfig.enabled ? drySettings : realSettings

  const setTradingSettings = useCallback((patch: TradingSettings | ((prev: TradingSettings) => TradingSettings)) => {
    if (dryRunConfig.enabled) {
      setDrySettings(patch as any)
    } else {
      setRealSettings(patch as any)
    }
  }, [dryRunConfig.enabled])

  // Per-user (per-browser) local persistence + manual backtest results.
  const [hydrated, setHydrated] = useState(false)
  const [backtests, setBacktests] = useState<BacktestResult[]>([])
  const [isBacktesting, setIsBacktesting] = useState(false)
  // Per-pair backtest stats (keyed by symbol) from the latest run — shared with the
  // Signals and Consensus tabs so all three views analyse the same data.
  const [pairStats, setPairStats] = useState<Record<string, PairStat>>({})

  // Load persisted state from Backend DB AFTER mount
  useEffect(() => {
    fetch("http://127.0.0.1:8765/api/ui-settings")
      .then((res) => res.json())
      .then((data) => {
        if (data.realSettings) {
          setRealSettings(data.realSettings)
        }
        if (data.drySettings) {
          setDrySettings(data.drySettings)
        } else if (data.tradingSettings) {
          // Fallback legacy migration
          const savedSettings = data.tradingSettings
          const savedById = new Map(savedSettings.cexes.map((c: any) => [c.id, c]))
          const mergedCexes = DEFAULT_TRADING_SETTINGS.cexes.map((def) => ({
            ...def,
            ...savedById.get(def.id),
          }))
          for (const c of savedSettings.cexes) {
            if (c.id === "all") continue
            if (!mergedCexes.some((m) => m.id === c.id)) mergedCexes.push(c)
          }
          const legacy = {
            ...savedSettings,
            cexes: mergedCexes,
            riskModel: savedSettings.riskModel ?? RISK_PRESETS.balanced,
          }
          setRealSettings(legacy)
          setDrySettings(legacy)
        } else {
          // Fallback to localStore migration
          const legacy = localStore.loadTradingSettings()
          if (legacy) {
            setRealSettings(legacy)
            setDrySettings(legacy)
          }
        }
        
        if (data.dryRunConfig) {
          setDryRunConfig(data.dryRunConfig)
        } else {
          const legacy = localStore.loadDryRun()
          if (legacy) setDryRunConfig(legacy)
        }
        
        const savedBacktests = localStore.loadBacktests()
        setBacktests(savedBacktests)
        if (savedBacktests[0]?.pairStats) {
          setPairStats(Object.fromEntries(savedBacktests[0].pairStats.map((p) => [p.symbol, p])))
        }
        setHydrated(true)
      })
      .catch((e) => {
        // Fallback to localStore on error
        const legacy = localStore.loadTradingSettings()
        if (legacy) {
          setRealSettings(legacy)
          setDrySettings(legacy)
        }
        const legacyDry = localStore.loadDryRun()
        if (legacyDry) setDryRunConfig(legacyDry)
        setHydrated(true)
      })
  }, [])

  // Persist settings + mode to Backend DB whenever they change (only after initial hydration).
  useEffect(() => {
    if (hydrated) {
      fetch("http://127.0.0.1:8765/api/ui-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ realSettings, drySettings, dryRunConfig }),
      }).catch(() => {})
    }
  }, [hydrated, realSettings, drySettings, dryRunConfig])

  // Style Agent Loop - Polls background style agent DB
  const [styleAgentData, setStyleAgentData] = useState<Record<string, any>>({})
  useEffect(() => {
    if (!hydrated) return
    const interval = setInterval(() => {
      fetch("http://127.0.0.1:8765/api/style-agents")
        .then((res) => res.json())
        .then((data) => {
          setStyleAgentData(data)
          
          // Apply Auto-Adjustments if custom_auto risk is enabled OR if the style is adaptive
          const styleName = tradingSettings.tradingStyle
          const agent = data[styleName]
          if (agent && tradingSettings.riskModel.preset === "custom_auto") {
            setTradingSettings(prev => {
              const newRisk = { ...prev.riskModel }
              // Dynamically adjust risk based on agent's optimal finding
              newRisk.maxPnlPct = agent.optimalRisk || newRisk.maxPnlPct
              
              const newCexes = [...prev.cexes]
              const activeIdx = newCexes.findIndex(c => c.id === prev.activeCex)
              if (activeIdx > -1) {
                // Apply agent's leverage findings
                newCexes[activeIdx].defaultLeverage = agent.optimalLeverage?.["BTCUSDT"] || newCexes[activeIdx].defaultLeverage
              }
              
              // Only trigger state update if there's an actual change to prevent infinite loops
              if (newRisk.maxPnlPct !== prev.riskModel.maxPnlPct || newCexes[activeIdx]?.defaultLeverage !== prev.cexes[activeIdx]?.defaultLeverage) {
                return { ...prev, riskModel: newRisk, cexes: newCexes }
              }
              return prev
            })
          }
        })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [hydrated, tradingSettings.tradingStyle, tradingSettings.riskModel.preset])
  
  // Real public market data + server-computed analytics (works on localhost + Vercel).
  // Keyed on the ACTIVE exchange so switching CEX in Settings re-pulls that
  // exchange's real, dynamic pair universe.
  const activeCexId = tradingSettings.activeCex
  const market = useSWR(["market", activeCexId], () => marketFetcher(activeCexId), {
    refreshInterval: 3000,
    keepPreviousData: true,
  })

  // Real engine state via the local/remote Go gateway (live trading account).
  const engine = useSWR<EngineSnapshot>("engine", pollEngine, {
    refreshInterval: 5000,
    keepPreviousData: true,
  })
  
  // Keep the analysed pair valid for the ACTIVE exchange. The pair list is fully
  // DYNAMIC — derived from the exchange's real market feed — so when the user
  // switches CEX (or the current symbol isn't listed there) we snap the analysis
  // to that exchange's most-liquid real pair instead of a hardcoded default.
  useEffect(() => {
    const rows = market.data?.market
    if (!rows || rows.length === 0) return
    const listed = rows.some((m) => m.symbol.toUpperCase() === analysisSymbol.toUpperCase())
    if (!listed) setAnalysisSymbol(rows[0].symbol)
  }, [market.data, analysisSymbol])

  // Agent analysis with progress tracking — runs on the chosen pair of the ACTIVE CEX.
  const agentAnalysis = useSWR<AgentAnalysisResponse | null>(
    [`agent-analysis`, analysisSymbol, activeCexId],
    () => agentAnalysisFetcher(analysisSymbol, activeCexId),
    {
      refreshInterval: 5000, // Refresh every 5s for real-time feel
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
      styleAgentData,
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
      // Compile UI settings into environment-compatible map for the Go Engine
      const engineCfg: Record<string, string> = {
        DRY_RUN: dryRunConfig.enabled ? "true" : "false",
        TRADING_STYLE: tradingSettings.tradingStyle,
        RISK_PCT: (tradingSettings.riskModel.maxPnlPct / 100).toString(),
        LEVERAGE: tradingSettings.cexes.find(c => c.id === tradingSettings.activeCex)?.defaultLeverage.toString() || "10",
        SYMBOL: tradingSettings.selectedSymbol || "BTCUSDT",
        COMPOUNDING: dryRunConfig.compounding ? "true" : "false",
      }
      
      // Inject API keys based on active CEX if Real Mode
      if (!dryRunConfig.enabled) {
        const activeCex = tradingSettings.cexes.find(c => c.id === tradingSettings.activeCex)
        if (activeCex && activeCex.id === "bybit") {
          // If we had a mechanism to fetch API keys from memory, we'd add them here.
          // For now, the backend already has them in .env, so we just enforce execution mode.
        }
      }

      await startEngine(engineCfg)
    } finally {
      engine.mutate()
    }
  }, [engine, dryRunConfig.enabled, tradingSettings])

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

  // Manual, per-user backtest. Triggered explicitly by the user (never auto-run).
  // Runs a REAL replay on the server over historical candles of the active CEX's
  // pairs, using the same signal + TP/SL strategy as the Signals/Consensus tabs.
  // The resulting per-pair stats are stored and shared back into those tabs.
  const runBacktest = useCallback(async (opts?: BacktestRunOptions) => {
    setIsBacktesting(true)
    try {
      const cex = tradingSettings.cexes.find((c) => c.id === tradingSettings.activeCex) ?? tradingSettings.cexes[0]
      const pairLeverage: Record<string, number> = {}
      for (const p of cex?.pairLeverage ?? []) pairLeverage[p.pair.toUpperCase()] = p.leverage

      // The replay chart focuses on the pair the user is actively looking at in
      // the app (analysisSymbol) unless the Backtest tab overrides it.
      const focusSymbol = opts?.focusSymbol || analysisSymbol

      const res = await fetch("/api/backtest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cex: tradingSettings.activeCex,
          cexLabel: cex?.label,
          style: tradingSettings.tradingStyle,
          risk: tradingSettings.riskModel,
          dryRun: dryRunConfig.enabled,
          initialBalance: dryRunConfig.initialBalance,
          riskPerTrade: dryRunConfig.riskPerTrade,
          marginMode: cex?.marginMode,
          marginUsagePct: cex?.marginUsagePct,
          defaultLeverage: cex?.defaultLeverage,
          pairLeverage,
          symbols: opts?.singlePairOnly && focusSymbol ? [focusSymbol] : snapshot.market.map((m) => m.symbol),
          timeframe: opts?.timeframe ?? "1h",
          periodDays: opts?.periodDays ?? 12,
          focusSymbol,
        }),
      })
      const json = await res.json()
      if (!json?.ok || !json.result) throw new Error(json?.error || "Backtest failed")
      const result = json.result as BacktestResult

      // We no longer auto-save to history here. It's triggered by the UI when replay finishes.
      setPairStats(Object.fromEntries((result.pairStats ?? []).map((p) => [p.symbol, p])))
      return result
    } finally {
      setIsBacktesting(false)
    }
  }, [tradingSettings, dryRunConfig, snapshot.market, analysisSymbol])

  const clearBacktests = useCallback(() => {
    setBacktests([])
    // NOTE: Only clears UI display, NOT the database.
    // Backtest history is persisted in Rust Brain (backtest_records.bin)
    // and will be retained for analysis and agent training.
    // localStorage cache is also cleared so UI starts fresh,
    // but DB is untouched.
    localStore.clearBacktests()
  }, [])

  const saveBacktestResult = useCallback((result: BacktestResult) => {
    setBacktests((prev) => {
      // Prevent saving the exact same run twice if the user replays it
      if (prev.some(b => b.timestamp === result.timestamp && b.trades === result.trades)) return prev;
      const next = [result, ...prev].slice(0, 20)
      localStore.saveBacktests(next)
      return next
    })
  }, [])

  return {
    snapshot,
    start,
    stop,
    refresh,
    loadingMarket: market.isLoading,
    loadingEngine: engine.isLoading,
    
    // Trading Context
    tradingSettings,
    updateTradingSettings,
    updateRiskModel,
    applyRiskPreset,
    updateCexConfig,
    dryRunConfig,
    toggleDryRun,
    updateDryRunConfig,

    // Analysis
    analysisSymbol,
    runAnalysis,
    isAnalyzing,
    agentAnalysis: agentAnalysis.data,
    
    // History & Evaluation
    lastGrade,
    pendingForecast,

    hydrated,

    // Backtesting
    backtests,
    isBacktesting,
    runBacktest,
    clearBacktests,
    saveBacktestResult,
    pairStats,
  }
}

export { EMPTY_PERF, EMPTY_RISK }
