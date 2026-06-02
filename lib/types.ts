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
  signalStatus: SignalStatus // bot consensus, only meaningful for the active symbol
  confidence: number // 0..1, bot confidence for the active symbol
  spark: number[]
}

// Live consensus decision from the trading engine (single real verdict).
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
