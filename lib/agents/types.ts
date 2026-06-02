// ────────────────────────────────────────────────────────────────────────────────
// Agent System Types — Flexible architecture for multi-agent quant analysis
// Inspired by Renaissance/Simons quantitative approach
// ────────────────────────────────────────────────────────────────────────────────

export type AgentVote = "LONG" | "SHORT" | "WAIT" | "VETO"
export type AnalysisTrigger = "trade_loss" | "trade_win" | "team_drawdown" | "scheduled" | "threshold_breach"

// Base interface for all agents — implement this to add new agents
export interface IAgent {
  id: string
  name: string
  category: AgentCategory
  weight: number
  enabled: boolean
  analyze: (input: AgentInput) => Promise<AgentOutput>
}

export type AgentCategory = 
  | "trend"        // Trend-following agents (MA, momentum)
  | "mean_revert"  // Mean reversion agents (RSI, Bollinger)
  | "sentiment"    // Sentiment/news analysis
  | "volume"       // Volume/OI analysis
  | "risk"         // Risk management/veto agents
  | "macro"        // Macro regime detection
  | "quant"        // Probabilistic / statistical models
  | "orderflow"    // Order book / liquidation / CVD flow
  | "onchain"      // Whale / on-chain / cross-market flow
  | "gatekeeper"   // Data-quality veto (no directional weight)

// A single OHLCV candle (mirrors rust-brain MarketSnapshot.candles).
export interface Candle {
  open: number
  high: number
  low: number
  close: number
  vol: number
}

// Full market snapshot passed to every agent. Mirrors the Rust `MarketSnapshot`
// so the 13 ported quant agents read identical fields. Fields that the public
// market feed cannot provide default to 0 — data-dependent agents then return
// WAIT gracefully instead of throwing.
export interface AgentInput {
  symbol: string
  price: number
  candles: Candle[]
  // Convenience projections of `candles` (kept in sync by the builder).
  closes: number[]
  highs: number[]
  lows: number[]
  volumes: number[]
  // Derivatives / market microstructure.
  openInterest: number   // OI in base units (Rust: snap.oi)
  lsr: number            // long/short account ratio
  fundingRate: number
  bid: number            // top-of-book / bid depth proxy
  ask: number            // top-of-book / ask depth proxy
  atr14: number
  // Sentiment + on-chain (0 when feed unavailable).
  sentimentScore: number // -1..1
  newsCount: number
  whaleInflowUsd: number
  longLiq1h: number
  shortLiq1h: number
  usdtDeltaPct: number
  kimchiPct: number
  timestamp: number
  tsMs: number
}

export interface AgentOutput {
  agentId: string
  vote: AgentVote
  confidence: number // 0-1
  reasoning: string
  metrics: Record<string, number>
  flags?: string[]
}

// Pipeline progress tracking — ensures we don't stop at 2/3
export type PipelineStage = 
  | "idle"
  | "fetching_data"
  | "running_agents"
  | "aggregating_votes"
  | "risk_check"
  | "generating_signal"
  | "self_evaluation"
  | "complete"
  | "error"

export interface PipelineProgress {
  stage: PipelineStage
  currentStep: number
  totalSteps: number
  agentsCompleted: number
  totalAgents: number
  message: string
  startedAt: number
  completedAt?: number
  error?: string
}

// Agent tunables for self-learning
export interface AgentTunables {
  weight: number
  convictionScale: number  // Multiplier for confidence
  activationGate: number   // Minimum confidence to vote
  params: Record<string, number>  // Agent-specific parameters
}

// Performance tracking for each agent
export interface AgentScorecard {
  trades: number
  correct: number
  incorrect: number
  accuracy: number
  recentAccuracy: number  // Last N trades
  pnlContrib: number      // P&L contribution in R
  wrongStreak: number
  recentResults: boolean[]  // Last 20 trade outcomes
}

// Self-evaluation report after each trade
export interface SelfEvaluationReport {
  agentId: string
  timestamp: number
  trigger: AnalysisTrigger
  tradeDirection: "LONG" | "SHORT"
  agentVote: AgentVote
  wasCorrect: boolean
  verdict: string
  adjustments: string[]
  tunablesBefore: AgentTunables
  tunablesAfter: AgentTunables
  scorecard: AgentScorecard
}

// Team-level performance (aggregate of all agents)
export interface TeamScorecard {
  trades: number
  wins: number
  losses: number
  netPnlR: number      // Net P&L in R-multiples
  peakR: number
  drawdownR: number
  winStreak: number
  lossStreak: number
  conservatismBias: number  // Team tendency toward WAIT
  recentResults: boolean[]
}

// Complete evolution state — persisted to JSON
export interface EvolutionState {
  version: number
  updatedMs: number
  agents: Record<string, AgentState>
  team: TeamScorecard
  reports: SelfEvaluationReport[]
}

export interface AgentState {
  tunables: AgentTunables
  scorecard: AgentScorecard
  lastReport?: SelfEvaluationReport | null
}

// Aggregated consensus from all agents
export interface TeamConsensus {
  signal: AgentVote
  confidence: number
  agreeingAgents: string[]
  dissentingAgents: string[]
  vetoAgents: string[]
  reasoning: string
  entry: number
  tp: number
  sl: number
}

// Registry for dynamic agent management
export interface AgentRegistry {
  agents: Map<string, IAgent>
  register: (agent: IAgent) => void
  unregister: (agentId: string) => void
  getAgent: (agentId: string) => IAgent | undefined
  getAllAgents: () => IAgent[]
  getEnabledAgents: () => IAgent[]
}
