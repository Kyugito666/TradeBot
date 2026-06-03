import type { Timeframe } from "./exchanges"

export type TradingStyle = "scalp" | "intraday" | "swing"

export interface BacktestRiskModel {
  atrMultiplier: number
  riskReward: number
  targetRoiPct: number
  maxPnlPct: number
}

export interface BacktestTrade {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entryTime: number
  entryPrice: number
  exitTime?: number
  exitPrice?: number
  tpTarget: number
  slTarget: number
  status: "OPEN" | "WIN" | "LOSS" | "TIMEOUT"
  pnl: number
  margin: number
  closeReason?: string
}

export interface PairStat {
  symbol: string
  trades: number
  wins: number
  losses: number
  winRate: number
  pnl: number
}

export interface ReplayBar {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface ReplayMarker {
  time: number
  position: "aboveBar" | "belowBar"
  color: string
  shape: "arrowUp" | "arrowDown" | "circle"
  text: string
}

export interface ReplayChart {
  symbol: string
  bars: ReplayBar[]
  markers: ReplayMarker[]
}

export interface BacktestResult {
  ts: number
  initialBalance: number
  finalBalance: number
  totalTrades: number
  wins: number
  losses: number
  winRate: number
  pnl: number
  history: BacktestTrade[]
  pairStats: PairStat[]
  chartData?: ReplayChart
}

export interface PairCandles {
  symbol: string
  closes: number[]
  highs: number[]
  lows: number[]
  opens: number[]
  volumes: number[]
  times: number[]
}

export interface ReplayConfig {
  style: TradingStyle
  risk: BacktestRiskModel
  dryRun: boolean
  marginMode?: "isolated" | "cross"
  marginUsagePct?: number
  defaultLeverage?: number
  pairLeverage?: Record<string, number>
}
