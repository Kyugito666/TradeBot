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
import fs from "fs"
import path from "path"

const RECENT_WINDOW = 20 // Track last 20 trades for recent accuracy
const MIN_WEIGHT = 0.1
const MAX_WEIGHT = 3.0
const WEIGHT_ADJUST_RATE = 0.05
const CONVICTION_ADJUST_RATE = 0.02

// ═══════════════════════════════════════════════════════════════════════════════
// STATE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════

function toCamelCase(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(v => toCamelCase(v))
  } else if (obj !== null && obj.constructor === Object) {
    return Object.keys(obj).reduce((result, key) => {
      const camelKey = key.replace(/([-_][a-z])/g, group => group.toUpperCase().replace('-', '').replace('_', ''))
      result[camelKey] = toCamelCase(obj[key])
      return result
    }, {} as any)
  }
  return obj
}

export function getEvolutionState(): EvolutionState {
  try {
    const dbPath = process.env.BOT_DB_PATH || process.cwd()
    const p1 = path.join(dbPath, "agent_evolution.json")
    const p2 = path.join(process.cwd(), "agent_evolution.json")
    let target = ""
    if (fs.existsSync(p1)) target = p1
    else if (fs.existsSync(p2)) target = p2
    
    if (target) {
      const raw = JSON.parse(fs.readFileSync(target, "utf-8"))
      const camel = toCamelCase(raw)
      return {
        version: camel.version || 1,
        updatedMs: camel.updatedMs || Date.now(),
        agents: camel.agents || {},
        team: camel.team || createInitialState().team,
        reports: camel.reports || []
      }
    }
  } catch (err) {
    console.error("Failed to load agent_evolution.json", err)
  }
  return createInitialState()
}

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
  // We no longer update the in-memory state here, because the Rust backend
  // handles the actual self-evaluation and writes to agent_evolution.json.
  // This just returns empty to satisfy the API.
  return []
}

