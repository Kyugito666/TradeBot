// ────────────────────────────────────────────────────────────────────────────────
// Self-Evaluation System — Continuous learning for each agent
// Triggered on trade loss/win to adjust weights and parameters
// ────────────────────────────────────────────────────────────────────────────────

import type {
  AgentState,
  AgentTunables,
  AgentScorecard,
  SelfEvaluationReport,
  TeamScorecard,
  EvolutionState,
  AnalysisTrigger,
  AgentOutput,
} from "./types"
import { agentRegistry } from "./registry"

const RECENT_WINDOW = 20 // Track last 20 trades for recent accuracy
const MIN_WEIGHT = 0.1
const MAX_WEIGHT = 3.0
const WEIGHT_ADJUST_RATE = 0.05
const CONVICTION_ADJUST_RATE = 0.02

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

let evolutionState: EvolutionState = createInitialState()

function createInitialState(): EvolutionState {
  return {
    version: 1,
    updatedMs: Date.now(),
    agents: {},
    team: {
      trades: 0,
      wins: 0,
      losses: 0,
      netPnlR: 0,
      peakR: 0,
      drawdownR: 0,
      winStreak: 0,
      lossStreak: 0,
      conservatismBias: 0,
      recentResults: []
    },
    reports: []
  }
}

function createInitialAgentState(agentId: string): AgentState {
  const agent = agentRegistry.getAgent(agentId)
  return {
    tunables: {
      weight: agent?.weight ?? 1.0,
      convictionScale: 1.0,
      activationGate: 0.2, // Minimum confidence to count
      params: {}
    },
    scorecard: {
      trades: 0,
      correct: 0,
      incorrect: 0,
      accuracy: 0,
      recentAccuracy: 0,
      pnlContrib: 0,
      wrongStreak: 0,
      recentResults: []
    }
  }
}

export function getEvolutionState(): EvolutionState {
  return evolutionState
}

export function setEvolutionState(state: EvolutionState): void {
  evolutionState = state
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE RESULT PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════

export interface TradeResult {
  symbol: string
  direction: "LONG" | "SHORT"
  pnlR: number // P&L in R-multiples (risk units)
  isWin: boolean
  agentVotes: AgentOutput[]
}

export function processTradeResult(result: TradeResult): SelfEvaluationReport[] {
  const { direction, pnlR, isWin, agentVotes } = result
  const reports: SelfEvaluationReport[] = []
  const trigger: AnalysisTrigger = isWin ? "trade_win" : "trade_loss"
  
  // Update team scorecard
  evolutionState.team.trades++
  evolutionState.team.netPnlR += pnlR
  evolutionState.team.recentResults.push(isWin)
  if (evolutionState.team.recentResults.length > RECENT_WINDOW) {
    evolutionState.team.recentResults.shift()
  }
  
  if (isWin) {
    evolutionState.team.wins++
    evolutionState.team.winStreak++
    evolutionState.team.lossStreak = 0
    evolutionState.team.peakR = Math.max(evolutionState.team.peakR, evolutionState.team.netPnlR)
  } else {
    evolutionState.team.losses++
    evolutionState.team.lossStreak++
    evolutionState.team.winStreak = 0
    evolutionState.team.drawdownR = Math.max(
      evolutionState.team.drawdownR,
      evolutionState.team.peakR - evolutionState.team.netPnlR
    )
  }
  
  // Process each agent's vote
  for (const vote of agentVotes) {
    const report = evaluateAgent(vote, direction, isWin, pnlR, trigger)
    if (report) {
      reports.push(report)
      evolutionState.reports.push(report)
    }
  }
  
  // Trim old reports (keep last 100)
  if (evolutionState.reports.length > 100) {
    evolutionState.reports = evolutionState.reports.slice(-100)
  }
  
  evolutionState.updatedMs = Date.now()
  evolutionState.version++
  
  // Check for team-level evaluation
  if (evolutionState.team.lossStreak >= 3) {
    triggerTeamEvaluation("team_drawdown")
  }
  
  return reports
}

function evaluateAgent(
  vote: AgentOutput,
  tradeDirection: "LONG" | "SHORT",
  isWin: boolean,
  pnlR: number,
  trigger: AnalysisTrigger
): SelfEvaluationReport | null {
  const agentId = vote.agentId
  
  // Initialize agent state if needed
  if (!evolutionState.agents[agentId]) {
    evolutionState.agents[agentId] = createInitialAgentState(agentId)
  }
  
  const agentState = evolutionState.agents[agentId]
  const { tunables, scorecard } = agentState
  
  // Determine if agent was correct
  // Agent is correct if:
  // - Vote matched direction and trade won
  // - Vote was opposite and trade lost (correctly avoided)
  // - Vote was WAIT and we should have waited (loss)
  const votedDirection = vote.vote === "LONG" || vote.vote === "SHORT"
  const votedCorrectly = 
    (vote.vote === tradeDirection && isWin) ||
    (vote.vote === "VETO" && !isWin) ||
    (vote.vote === "WAIT" && !isWin) ||
    (votedDirection && vote.vote !== tradeDirection && !isWin)
  
  const wasCorrect = votedCorrectly
  
  // Update scorecard
  scorecard.trades++
  if (wasCorrect) {
    scorecard.correct++
    scorecard.wrongStreak = 0
  } else {
    scorecard.incorrect++
    scorecard.wrongStreak++
  }
  
  scorecard.recentResults.push(wasCorrect)
  if (scorecard.recentResults.length > RECENT_WINDOW) {
    scorecard.recentResults.shift()
  }
  
  scorecard.accuracy = scorecard.trades > 0 
    ? scorecard.correct / scorecard.trades 
    : 0
  scorecard.recentAccuracy = scorecard.recentResults.length > 0
    ? scorecard.recentResults.filter(Boolean).length / scorecard.recentResults.length
    : 0
  
  // Attribute P&L contribution
  if (votedDirection && vote.vote === tradeDirection) {
    scorecard.pnlContrib += pnlR * vote.confidence
  }
  
  // Store tunables before adjustment
  const tunablesBefore: AgentTunables = { ...tunables, params: { ...tunables.params } }
  
  // Adjust tunables based on performance
  const adjustments: string[] = []
  
  if (wasCorrect) {
    // Reward correct prediction
    if (tunables.weight < MAX_WEIGHT) {
      tunables.weight = Math.min(MAX_WEIGHT, tunables.weight + WEIGHT_ADJUST_RATE)
      adjustments.push(`Weight +${(WEIGHT_ADJUST_RATE * 100).toFixed(1)}%`)
    }
    if (vote.confidence > 0.7) {
      tunables.convictionScale = Math.min(1.5, tunables.convictionScale + CONVICTION_ADJUST_RATE)
      adjustments.push(`Conviction scale +${(CONVICTION_ADJUST_RATE * 100).toFixed(1)}%`)
    }
  } else {
    // Penalize wrong prediction
    if (tunables.weight > MIN_WEIGHT) {
      const penalty = WEIGHT_ADJUST_RATE * (scorecard.wrongStreak >= 3 ? 2 : 1)
      tunables.weight = Math.max(MIN_WEIGHT, tunables.weight - penalty)
      adjustments.push(`Weight -${(penalty * 100).toFixed(1)}%`)
    }
    
    // Reduce conviction if overconfident and wrong
    if (vote.confidence > 0.6) {
      tunables.convictionScale = Math.max(0.5, tunables.convictionScale - CONVICTION_ADJUST_RATE * 2)
      adjustments.push(`Conviction scale -${(CONVICTION_ADJUST_RATE * 2 * 100).toFixed(1)}% (overconfident)`)
    }
    
    // Raise activation gate if too trigger-happy
    if (scorecard.wrongStreak >= 3) {
      tunables.activationGate = Math.min(0.5, tunables.activationGate + 0.05)
      adjustments.push(`Activation gate raised to ${tunables.activationGate.toFixed(2)}`)
    }
  }
  
  // Build verdict
  let verdict = wasCorrect ? "CORRECT" : "INCORRECT"
  if (scorecard.wrongStreak >= 3) {
    verdict += " - ON WATCH (3+ wrong streak)"
  }
  if (scorecard.recentAccuracy < 0.4 && scorecard.recentResults.length >= 10) {
    verdict += " - UNDERPERFORMING"
  }
  
  const report: SelfEvaluationReport = {
    agentId,
    timestamp: Date.now(),
    trigger,
    tradeDirection,
    agentVote: vote.vote,
    wasCorrect,
    verdict,
    adjustments,
    tunablesBefore,
    tunablesAfter: { ...tunables, params: { ...tunables.params } },
    scorecard: { ...scorecard, recentResults: [...scorecard.recentResults] }
  }
  
  agentState.lastReport = report
  
  return report
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEAM-LEVEL EVALUATION
// ═══════════════════════════════════════════════════════════════════════════════

export function triggerTeamEvaluation(trigger: AnalysisTrigger): void {
  console.log(`[Evolution] Team evaluation triggered: ${trigger}`)
  
  const team = evolutionState.team
  const agents = evolutionState.agents
  
  // Find underperforming agents
  for (const [agentId, state] of Object.entries(agents)) {
    const { scorecard, tunables } = state
    
    // Severely penalize consistently wrong agents
    if (scorecard.recentAccuracy < 0.35 && scorecard.recentResults.length >= 10) {
      tunables.weight = Math.max(MIN_WEIGHT, tunables.weight * 0.8)
      tunables.activationGate = Math.min(0.6, tunables.activationGate + 0.1)
      console.log(`[Evolution] Agent ${agentId} severely penalized: weight=${tunables.weight.toFixed(2)}, gate=${tunables.activationGate.toFixed(2)}`)
    }
    
    // Boost well-performing agents during drawdown
    if (scorecard.recentAccuracy > 0.65 && scorecard.recentResults.length >= 10) {
      tunables.weight = Math.min(MAX_WEIGHT, tunables.weight * 1.1)
      console.log(`[Evolution] Agent ${agentId} boosted during drawdown: weight=${tunables.weight.toFixed(2)}`)
    }
  }
  
  // Increase team conservatism after losses
  if (trigger === "team_drawdown") {
    team.conservatismBias = Math.min(0.5, team.conservatismBias + 0.1)
    console.log(`[Evolution] Team conservatism increased to ${team.conservatismBias.toFixed(2)}`)
  }
  
  evolutionState.updatedMs = Date.now()
  evolutionState.version++
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

export function serializeState(): string {
  return JSON.stringify(evolutionState, null, 2)
}

export function loadState(json: string): void {
  try {
    const parsed = JSON.parse(json) as EvolutionState
    evolutionState = parsed
    console.log(`[Evolution] State loaded: v${parsed.version}, ${Object.keys(parsed.agents).length} agents`)
  } catch (err) {
    console.error("[Evolution] Failed to load state:", err)
  }
}

export function resetState(): void {
  evolutionState = createInitialState()
  console.log("[Evolution] State reset to initial")
}
