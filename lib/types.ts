export type SignalStatus = "LONG" | "SHORT" | "WAIT"
export type TrendState = "BULLISH" | "BEARISH" | "NEUTRAL"
export type WhaleBias = "LONG_HEAVY" | "SHORT_HEAVY" | "BALANCED"
export type BotMode = "RUNNING" | "PAUSED" | "STOPPED"
export type PositionSide = "LONG" | "SHORT"

// One specialist agent in the consensus engine (RenTech-style committee)
export type AgentVote = "LONG" | "SHORT" | "WAIT" | "VETO"
export interface Agent {
  id: string
  name: string
  role: string
  vote: AgentVote
  confidence: number // 0..1
  weight: number // contribution to consensus
  note: string
  canVeto: boolean
}

export interface MarketRow {
  symbol: string
  lastPrice: number
  pct24h: number
  openInterest: number
  lsrVal: number // long/short ratio
  trendState: TrendState
  whaleBias: WhaleBias
  signalStatus: SignalStatus
  confidence: number
  spark: number[]
}

export interface Consensus {
  symbol: string
  action: SignalStatus
  confidence: number
  reason: string
  vetoed: boolean
  agents: Agent[]
  entryTarget: number
  tpTarget: number
  slTarget: number
}

export interface Position {
  id: string
  symbol: string
  side: PositionSide
  size: number // contracts/units
  notional: number
  entry: number
  mark: number
  liq: number
  leverage: number
  unrealized: number // USD
  unrealizedPct: number
  tp: number
  sl: number
  openedAt: string
}

export interface RiskMetrics {
  equity: number
  marginUsed: number
  marginFree: number
  marginRatio: number // 0..1 used
  netExposure: number // signed USD
  grossExposure: number
  maxDrawdown: number // pct
  currentDrawdown: number // pct
  sharpe: number
  sortino: number
  valueAtRisk: number // 95% 1d, USD
  dailyLossLimit: number
  dailyPnl: number
  openPositions: number
  killSwitchArmed: boolean
}

export interface PerfPoint {
  t: string
  equity: number
  benchmark: number
}

export interface Performance {
  curve: PerfPoint[]
  totalReturnPct: number
  todayPct: number
  weekPct: number
  monthPct: number
  winRate: number
  profitFactor: number
  trades: number
  avgWin: number
  avgLoss: number
  bestDay: number
  worstDay: number
}

export interface LogEvent {
  id: string
  time: string
  level: "INFO" | "SIGNAL" | "EXEC" | "RISK" | "VETO"
  symbol?: string
  message: string
}

export interface Snapshot {
  mode: BotMode
  uptimeSec: number
  cycle: number
  latencyMs: number
  market: MarketRow[]
  consensus: Consensus
  positions: Position[]
  risk: RiskMetrics
  performance: Performance
  log: LogEvent[]
}
