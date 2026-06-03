export type SignalStatus = "LONG" | "SHORT" | "WAIT"
export type TrendState = "BULLISH" | "BEARISH" | "NEUTRAL"
export type WhaleBias = "LONG_HEAVY" | "SHORT_HEAVY" | "BALANCED"
export type BotMode = "RUNNING" | "STOPPED"
export type PositionSide = "LONG" | "SHORT"

// One row of the live market scan — sourced from a real public exchange feed.
export interface MarketRow {
  symbol: string
  lastPrice: number
  pct24h: number
  openInterest: number // notional USD
  lsrVal: number // long/short account ratio (real)
  trendState: TrendState
  whaleBias: WhaleBias
  signalStatus: SignalStatus // computed TA signal (or engine verdict for the active pair)
  confidence: number // 0..1 signal agreement strength
  rsi: number // Wilder RSI(14) from real candles
  spark: number[]
}

// A single consensus verdict. Sourced either from the live Go engine
// ("engine") or computed server-side from real market analytics ("analytics").
export interface Consensus {
  symbol: string
  action: SignalStatus
  confidence: number
  reason: string
  trendState: TrendState
  whaleBias: WhaleBias
  entryTarget: number
  tpTarget: number
  slTarget: number
  updatedAt: string
  source: "engine" | "analytics"
}

// Shape returned by GET /api/market.
export interface MarketResponse {
  ok: boolean
  ts: number
  market: MarketRow[]
  consensus: Consensus | null
  error?: string
}

export interface Position {
  id: string
  symbol: string
  side: PositionSide
  entry: number
  mark: number
  tp: number
  sl: number
  margin: number // USD margin allocated
  pnlPct: number // ROE %
  pnlUsd: number // unrealized USD
  status: string
  openedAt: string
}

export interface RiskMetrics {
  equity: number
  balance: number
  marginUsed: number
  marginFree: number
  marginRatio: number // 0..1 used
  netExposure: number // signed USD
  grossExposure: number
  dailyPnl: number
  openPositions: number
  dryRun: boolean
}

export interface PerfPoint {
  t: string
  equity: number
}

export interface Performance {
  curve: PerfPoint[]
  totalReturnPct: number
  todayPct: number
  realizedPnl: number
  winRate: number
  profitFactor: number
  trades: number
  wins: number
  losses: number
  avgWin: number
  avgLoss: number
  bestTrade: number
  worstTrade: number
}

export interface LogEvent {
  id: string
  time: string
  level: "INFO" | "SIGNAL" | "EXEC" | "RISK" | "VETO" | "WARNING" | "ERROR" | "DEBUG"
  name?: string
  symbol?: string
  message: string
}

export interface Snapshot {
  mode: BotMode
  engineOnline: boolean
  activeSymbol: string
  uptimeSec: number
  cycle: number
  latencyMs: number
  marketOnline: boolean
  market: MarketRow[]
  consensus: Consensus | null
  positions: Position[]
  risk: RiskMetrics
  performance: Performance
  log: LogEvent[]
}

// ── Raw engine payloads (mirror go-engine/gateway/server.go) ───────────────────

export interface EngineInsight {
  symbol: string
  last_price: number
  open_interest: number
  lsr_val: number
  pct_24h: number
  atr?: number
  trend_state: string
  whale_bias: string
  signal_status: string
  advice: string
  timestamp: string
  balance: number
  entry_target: number
  tp_target: number
  sl_target: number
}

export interface EnginePosition {
  symbol: string
  side: string
  entry_price: number
  limit_price?: number
  take_profit: number
  stop_loss: number
  time: string
  status: string
  pnl: number
  margin: number
}

export interface EngineLogLine {
  ts: string
  level: string
  name: string
  msg: string
}

// ── Agent self-evaluation framework (mirrors rust-brain/src/evolution/mod.rs) ──

export interface AgentTunables {
  weight: number
  conviction_scale: number
  activation_gate: number
  params?: Record<string, number>
}

export interface AgentScorecard {
  trades: number
  correct: number
  incorrect: number
  accuracy: number
  recent_accuracy: number
  pnl_contrib: number
  wrong_streak: number
  recent?: boolean[]
}

export interface EvaluationReport {
  agent: string
  ts_ms: number
  trigger: string // "trade_loss" | "trade_win" | "team_drawdown"
  trade_direction: string
  agent_vote: string
  was_correct: boolean
  verdict: string
  adjustments: string[]
  weight_before: number
  weight_after: number
  conviction_scale_before: number
  conviction_scale_after: number
  activation_gate_before: number
  activation_gate_after: number
  accuracy: number
  recent_accuracy: number
}

export interface AgentRecord {
  tunables: AgentTunables
  scorecard: AgentScorecard
  last_report?: EvaluationReport | null
}

export interface TeamScorecard {
  trades: number
  wins: number
  losses: number
  net_pnl_r: number
  peak_r: number
  drawdown_r: number
  win_streak: number
  loss_streak: number
  conservatism_bias: number
  recent_results?: boolean[]
}

export interface EvolutionState {
  version: number
  updated_ms: number
  agents: Record<string, AgentRecord>
  team: TeamScorecard
  reports: EvaluationReport[]
}

// Shape returned by GET /api/agents.
export interface AgentsResponse {
  ok: boolean
  ts: number
  state: EvolutionState | null
  error?: string
}

export interface PaperTrade {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entry: number
  tp: number
  sl: number
  leverage: number
  confidence: number
  openedAt: number
  reason: string
  agentVotes?: any[]
  exitPrice?: number
  outcome?: string
  pnlR?: number
  pnlPct?: number
}

export interface SignalCandidate {
  row: MarketRow
  levels: {
    side: "LONG" | "SHORT"
    entry: number
    tp: number
    sl: number
    leverage: number
    riskReward: number
    expectedRoiPct: number
  }
}

