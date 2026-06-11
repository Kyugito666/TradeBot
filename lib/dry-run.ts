// ────────────────────────────────────────────────────────────────────────────────
// Paper Trading / Dry-Run Simulation Engine
// Simulates trades locally without connecting to real exchange
// ────────────────────────────────────────────────────────────────────────────────

import type { TeamConsensus, AgentOutput, TradeResult } from "./agents"
import { processTradeResult } from "./agents/self-evaluation"

export interface DryRunConfig {
  enabled: boolean
  initialBalance: number
  currentBalance: number
  riskPerTrade: number  // Decimal (0.02 = 2%)
  maxDrawdown: number   // Max allowed drawdown before stopping
}

export interface SimulatedPosition {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entry: number
  size: number        // Position size in USD
  margin: number      // Margin used
  tp: number
  sl: number
  openedAt: number
  status: "OPEN" | "CLOSED_TP" | "CLOSED_SL" | "CLOSED_MANUAL"
  closedAt?: number
  closePrice?: number
  pnl?: number
  pnlPct?: number
}

export interface SimulatedTrade extends SimulatedPosition {
  agentVotes: AgentOutput[]
  consensusSignal: TeamConsensus
}

export interface DryRunState {
  config: DryRunConfig
  positions: SimulatedPosition[]
  history: SimulatedTrade[]
  stats: {
    trades: number
    wins: number
    losses: number
    totalPnl: number
    maxDrawdown: number
    peakBalance: number
    winRate: number
    profitFactor: number
    avgWin: number
    avgLoss: number
  }
}

// Initialize dry-run state
export function createDryRunState(config: Partial<DryRunConfig> = {}): DryRunState {
  const initialBalance = config.initialBalance ?? 10
  return {
    config: {
      enabled: config.enabled ?? true,
      initialBalance,
      currentBalance: initialBalance,
      riskPerTrade: config.riskPerTrade ?? 0.02,
      maxDrawdown: config.maxDrawdown ?? 0.2,
    },
    positions: [],
    history: [],
    stats: {
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      maxDrawdown: 0,
      peakBalance: initialBalance,
      winRate: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
    },
  }
}

// Open a simulated position based on consensus
export function openSimulatedPosition(
  state: DryRunState,
  consensus: TeamConsensus,
  agentVotes: AgentOutput[],
  currentPrice: number
): DryRunState {
  if (!state.config.enabled) return state
  if (consensus.signal === "WAIT" || consensus.signal === "VETO") return state
  
  // Check for existing position in same symbol
  const existingPos = state.positions.find(
    p => p.status === "OPEN" && p.symbol === "BTCUSDT" // TODO: Dynamic symbol
  )
  if (existingPos) {
    console.log("[DryRun] Position already open, skipping")
    return state
  }
  
  // Calculate position size based on risk
  const riskAmount = state.config.currentBalance * state.config.riskPerTrade
  const stopDistance = Math.abs(currentPrice - consensus.sl)
  const stopPct = stopDistance / currentPrice
  const positionSize = stopPct > 0 ? riskAmount / stopPct : riskAmount
  const margin = Math.min(positionSize, state.config.currentBalance * 0.5) // Max 50% of balance
  
  const position: SimulatedPosition = {
    id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: "BTCUSDT", // TODO: Dynamic symbol
    side: consensus.signal as "LONG" | "SHORT",
    entry: currentPrice,
    size: positionSize,
    margin,
    tp: consensus.tp,
    sl: consensus.sl,
    openedAt: Date.now(),
    status: "OPEN",
  }
  
  console.log(`[DryRun] Opened ${position.side} position at $${currentPrice}`, {
    margin,
    tp: consensus.tp,
    sl: consensus.sl,
  })
  
  return {
    ...state,
    positions: [...state.positions, position],
    config: {
      ...state.config,
      currentBalance: state.config.currentBalance - margin,
    },
  }
}

// Update positions with current price (check TP/SL)
export function updateSimulatedPositions(
  state: DryRunState,
  currentPrice: number,
  agentVotes: AgentOutput[]
): DryRunState {
  if (!state.config.enabled) return state
  
  let newState = { ...state }
  const updatedPositions: SimulatedPosition[] = []
  const closedTrades: SimulatedTrade[] = []
  
  for (const pos of state.positions) {
    if (pos.status !== "OPEN") {
      updatedPositions.push(pos)
      continue
    }
    
    let closePrice: number | null = null
    let closeStatus: SimulatedPosition["status"] = "OPEN"
    
    // Check take profit
    if (pos.side === "LONG" && currentPrice >= pos.tp) {
      closePrice = pos.tp
      closeStatus = "CLOSED_TP"
    } else if (pos.side === "SHORT" && currentPrice <= pos.tp) {
      closePrice = pos.tp
      closeStatus = "CLOSED_TP"
    }
    
    // Check stop loss
    if (pos.side === "LONG" && currentPrice <= pos.sl) {
      closePrice = pos.sl
      closeStatus = "CLOSED_SL"
    } else if (pos.side === "SHORT" && currentPrice >= pos.sl) {
      closePrice = pos.sl
      closeStatus = "CLOSED_SL"
    }
    
    if (closePrice !== null) {
      // Calculate P&L
      const priceDiff = pos.side === "LONG" 
        ? closePrice - pos.entry 
        : pos.entry - closePrice
      const pnlPct = (priceDiff / pos.entry) * 100
      const pnl = pos.margin * (pnlPct / 100)
      
      const closedPos: SimulatedPosition = {
        ...pos,
        status: closeStatus,
        closedAt: Date.now(),
        closePrice,
        pnl,
        pnlPct,
      }
      
      updatedPositions.push(closedPos)
      
      // Add to trade history
      const trade: SimulatedTrade = {
        ...closedPos,
        agentVotes,
        consensusSignal: {
          signal: pos.side,
          confidence: 0,
          agreeingAgents: [],
          dissentingAgents: [],
          vetoAgents: [],
          reasoning: "",
          entry: pos.entry,
          tp: pos.tp,
          sl: pos.sl,
        },
      }
      closedTrades.push(trade)
      
      // Return margin + P&L to balance
      newState.config.currentBalance += pos.margin + pnl
      
      console.log(`[DryRun] Closed ${pos.side} at $${closePrice} (${closeStatus})`, {
        pnl: pnl.toFixed(2),
        pnlPct: pnlPct.toFixed(2) + "%",
      })
      
      // Process trade result for self-evaluation
      const tradeResult: TradeResult = {
        symbol: pos.symbol,
        direction: pos.side,
        pnlR: pnl / (state.config.currentBalance * state.config.riskPerTrade), // Convert to R-multiples
        isWin: pnl > 0,
        agentVotes,
      }
      processTradeResult(tradeResult)
      
    } else {
      updatedPositions.push(pos)
    }
  }
  
  // Update history and stats
  if (closedTrades.length > 0) {
    const newHistory = [...state.history, ...closedTrades]
    newState = {
      ...newState,
      positions: updatedPositions,
      history: newHistory,
      stats: calculateStats(newHistory, newState.config.initialBalance),
    }
  } else {
    newState.positions = updatedPositions
  }
  
  // Check max drawdown
  const drawdown = (newState.stats.peakBalance - newState.config.currentBalance) / newState.stats.peakBalance
  if (drawdown >= newState.config.maxDrawdown) {
    console.warn(`[DryRun] Max drawdown reached (${(drawdown * 100).toFixed(1)}%), stopping trading`)
    newState.config.enabled = false
  }
  
  return newState
}

// Calculate statistics from trade history
function calculateStats(
  history: SimulatedTrade[],
  initialBalance: number
): DryRunState["stats"] {
  const closedTrades = history.filter(t => t.status !== "OPEN")
  const trades = closedTrades.length
  
  if (trades === 0) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnl: 0,
      maxDrawdown: 0,
      peakBalance: initialBalance,
      winRate: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
    }
  }
  
  const wins = closedTrades.filter(t => (t.pnl ?? 0) > 0)
  const losses = closedTrades.filter(t => (t.pnl ?? 0) <= 0)
  
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const totalWinPnl = wins.reduce((sum, t) => sum + (t.pnl ?? 0), 0)
  const totalLossPnl = Math.abs(losses.reduce((sum, t) => sum + (t.pnl ?? 0), 0))
  
  // Calculate running balance and max drawdown
  let balance = initialBalance
  let peakBalance = initialBalance
  let maxDrawdown = 0
  
  for (const trade of closedTrades) {
    balance += trade.pnl ?? 0
    peakBalance = Math.max(peakBalance, balance)
    const dd = (peakBalance - balance) / peakBalance
    maxDrawdown = Math.max(maxDrawdown, dd)
  }
  
  return {
    trades,
    wins: wins.length,
    losses: losses.length,
    totalPnl,
    maxDrawdown,
    peakBalance,
    winRate: trades > 0 ? (wins.length / trades) * 100 : 0,
    profitFactor: totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? 99 : 0,
    avgWin: wins.length > 0 ? totalWinPnl / wins.length : 0,
    avgLoss: losses.length > 0 ? -totalLossPnl / losses.length : 0,
  }
}

// Close position manually
export function closeSimulatedPosition(
  state: DryRunState,
  positionId: string,
  currentPrice: number,
  agentVotes: AgentOutput[]
): DryRunState {
  const posIndex = state.positions.findIndex(p => p.id === positionId && p.status === "OPEN")
  if (posIndex === -1) return state
  
  const pos = state.positions[posIndex]
  const priceDiff = pos.side === "LONG" 
    ? currentPrice - pos.entry 
    : pos.entry - currentPrice
  const pnlPct = (priceDiff / pos.entry) * 100
  const pnl = pos.margin * (pnlPct / 100)
  
  const closedPos: SimulatedPosition = {
    ...pos,
    status: "CLOSED_MANUAL",
    closedAt: Date.now(),
    closePrice: currentPrice,
    pnl,
    pnlPct,
  }
  
  const trade: SimulatedTrade = {
    ...closedPos,
    agentVotes,
    consensusSignal: {
      signal: pos.side,
      confidence: 0,
      agreeingAgents: [],
      dissentingAgents: [],
      vetoAgents: [],
      reasoning: "Manual close",
      entry: pos.entry,
      tp: pos.tp,
      sl: pos.sl,
    },
  }
  
  const newPositions = [...state.positions]
  newPositions[posIndex] = closedPos
  
  const newHistory = [...state.history, trade]
  
  // Process for self-evaluation
  const tradeResult: TradeResult = {
    symbol: pos.symbol,
    direction: pos.side,
    pnlR: pnl / (state.config.currentBalance * state.config.riskPerTrade),
    isWin: pnl > 0,
    agentVotes,
  }
  processTradeResult(tradeResult)
  
  return {
    ...state,
    positions: newPositions,
    history: newHistory,
    config: {
      ...state.config,
      currentBalance: state.config.currentBalance + pos.margin + pnl,
    },
    stats: calculateStats(newHistory, state.config.initialBalance),
  }
}

// Reset dry-run state
export function resetDryRunState(config?: Partial<DryRunConfig>): DryRunState {
  return createDryRunState(config)
}
