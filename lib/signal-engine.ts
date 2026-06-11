// ────────────────────────────────────────────────────────────────────────────
// Signal forward-test engine — pure, deterministic helpers for the Signal tab.
//
// Everything here is paper-only. It derives Entry / TP / SL for every qualifying
// pair from the LIVE market scan (MarketRow) combined with the user's risk preset
// and trading style from the Settings tab. No real account, no order execution.
//
// Levels are computed from a volatility proxy (derived from each pair's recent
// price spark) scaled by the preset's ATR multiplier and risk:reward — so the
// behaviour follows Settings without any free-form numeric input.
// ────────────────────────────────────────────────────────────────────────────

import type { MarketRow } from "./types"
import type { CexConfig, RiskModel, TradingStyle } from "@/hooks/use-live-data"

export type SignalSide = "LONG" | "SHORT"

export interface SignalLevels {
  side: SignalSide
  entry: number
  tp: number
  sl: number
  /** Volatility proxy as a fraction of price (ATR%). */
  atrPct: number
  /** Stop distance as a fraction of entry. */
  slDistPct: number
  /** Target distance as a fraction of entry. */
  tpDistPct: number
  /** Resolved leverage for this pair from the active CEX config. */
  leverage: number
  /** Expected ROI on margin at TP (price move × leverage), %. */
  expectedRoiPct: number
  /** Risk:reward used (reward side). */
  riskReward: number
}

export interface SignalCandidate {
  row: MarketRow
  levels: SignalLevels
}

// ── Filter: only directional setups that clear the style confidence gate ──────
// Higher-frequency styles demand stronger agreement before a setup is shown.
const STYLE_MIN_CONFIDENCE: Record<string, number> = {
  scalp: 0.15,
  hft: 0.10,
  intraday: 0.20,
  swing: 0.25,
}

export function styleConfidenceGate(style: string): number {
  return STYLE_MIN_CONFIDENCE[style] ?? 0.15
}

export function passesFilter(row: MarketRow, style: string): boolean {
  // Only check if there's a valid direction. 
  // We completely bypass the client-side confidence filter to show ALL raw signals.
  if (row.signalStatus !== "LONG" && row.signalStatus !== "SHORT") return false
  
  return true
}

// ── Volatility proxy from the recent price spark (mean absolute return) ────────
export function sparkAtrPct(spark: number[], lastPrice: number): number {
  if (!spark || spark.length < 2 || lastPrice <= 0) return 0.012 // 1.2% fallback band
  let sumAbs = 0
  let n = 0
  for (let i = 1; i < spark.length; i++) {
    const prev = spark[i - 1]
    if (prev > 0) {
      sumAbs += Math.abs((spark[i] - prev) / prev)
      n++
    }
  }
  const avg = n > 0 ? sumAbs / n : 0.005
  // Clamp to a sane band so a flat or spiky spark can't produce absurd levels.
  // We use 0.001 (0.1%) as an absolute floor to allow tight HFT / Scalping entries.
  return Math.min(0.08, Math.max(0.001, avg))
}

// ── Resolve leverage for a pair from the active CEX config ────────────────────
export function resolveLeverage(symbol: string, cex: CexConfig | undefined): number {
  if (!cex) return 5
  const override = cex.pairLeverage.find((p) => p.pair.toUpperCase() === symbol.toUpperCase())
  return override?.leverage ?? cex.defaultLeverage
}

function round(value: number, price: number): number {
  if (!price || price === 0) return value
  if (price >= 1000) return Number(value.toFixed(2))
  if (price >= 10) return Number(value.toFixed(3))
  if (price >= 1) return Number(value.toFixed(4))
  if (price >= 0.1) return Number(value.toFixed(5))
  if (price >= 0.01) return Number(value.toFixed(6))
  return Number(value.toPrecision(5))
}

// ── Compute Entry / TP / SL for a row using the risk preset + active CEX ──────
// Entry uses LIMIT ORDER pricing: entry is placed AWAY from current price
// (below for LONG, above for SHORT) to get a better fill.
export function computeLevels(row: MarketRow, risk: RiskModel, cex: CexConfig | undefined): SignalLevels {
  const side: SignalSide = row.signalStatus === "SHORT" ? "SHORT" : "LONG"
  const last = row.lastPrice
  const atrPct = sparkAtrPct(row.spark, last)

  const slDistPct = atrPct * risk.atrMultiplier
  const tpDistPct = slDistPct * risk.riskReward
  const leverage = resolveLeverage(row.symbol, cex)

  // Limit order offset: 30% of ATR away from current price
  const limitOffset = atrPct * 0.3

  let entry = last
  let tp = last
  let sl = last
  if (side === "LONG") {
    entry = last * (1 - limitOffset)  // Limit buy below current price
    tp = entry * (1 + tpDistPct)
    sl = entry * (1 - slDistPct)
  } else {
    entry = last * (1 + limitOffset)  // Limit sell above current price
    tp = entry * (1 - tpDistPct)
    sl = entry * (1 + slDistPct)
  }

  return {
    side,
    entry: round(entry, last),
    tp: round(tp, last),
    sl: round(sl, last),
    atrPct,
    slDistPct,
    tpDistPct,
    leverage,
    expectedRoiPct: Number((tpDistPct * leverage * 100).toFixed(1)),
    riskReward: risk.riskReward,
  }
}

// ── Build the filtered, level-annotated candidate list (sorted by confidence) ─
export function buildCandidates(
  market: MarketRow[],
  style: TradingStyle,
  risk: RiskModel,
  cex: CexConfig | undefined,
): SignalCandidate[] {
  return market
    .filter((row) => passesFilter(row, style))
    .map((row) => ({ row, levels: computeLevels(row, risk, cex) }))
    .sort((a, b) => b.row.confidence - a.row.confidence)
}

// ── Paper trade lifecycle (forward-test) ──────────────────────────────────────
export interface PaperTrade {
  id: string
  symbol: string
  side: SignalSide
  entry: number
  tp: number
  sl: number
  leverage: number
  confidence: number
  margin: number
  openedAt: number
  reason: string
  /** Limit order status: PENDING (not filled), FILLED (live), CLOSED */
  status?: "PENDING" | "FILLED" | "CLOSED"
  /** Live price tracking for pending orders */
  livePrice?: number
  // Filled when closed:
  closedAt?: number
  exitPrice?: number
  outcome?: "TP" | "SL" | "MANUAL"
  pnlPct?: number // ROE on margin (price move × leverage)
  pnlR?: number // R-multiple (reward in stop-risk units)
  // Snapshot of the agent votes at entry (when available) for self-evaluation.
  agentVotes?: { agentId: string; vote: string; confidence: number }[]
}

// Evaluate an open trade against the latest mark price. Returns the closed trade
// if TP or SL was hit, otherwise null (still open).
export function evaluateTrade(trade: PaperTrade, mark: number): PaperTrade | null {
  if (mark <= 0) return null
  let outcome: "TP" | "SL" | null = null
  if (trade.side === "LONG") {
    if (mark >= trade.tp) outcome = "TP"
    else if (mark <= trade.sl) outcome = "SL"
  } else {
    if (mark <= trade.tp) outcome = "TP"
    else if (mark >= trade.sl) outcome = "SL"
  }
  if (!outcome) return null

  const exitPrice = outcome === "TP" ? trade.tp : trade.sl
  return { ...trade, ...closeFields(trade, exitPrice, outcome) }
}

function closeFields(trade: PaperTrade, exitPrice: number, outcome: "TP" | "SL" | "MANUAL") {
  const dir = trade.side === "LONG" ? 1 : -1
  const priceMovePct = ((exitPrice - trade.entry) / trade.entry) * dir
  const risk = Math.abs(trade.entry - trade.sl)
  const reward = (exitPrice - trade.entry) * dir
  return {
    closedAt: Date.now(),
    exitPrice,
    outcome,
    pnlPct: Number((priceMovePct * trade.leverage * 100).toFixed(2)),
    pnlR: risk > 0 ? Number((reward / risk).toFixed(3)) : 0,
  }
}

// Close a trade manually at the current mark (used by the manual close button).
export function closeTradeManual(trade: PaperTrade, mark: number): PaperTrade {
  return { ...trade, ...closeFields(trade, mark, "MANUAL") }
}

export interface PaperStats {
  total: number
  wins: number
  losses: number
  winRate: number
  netR: number
  netRoiPct: number
  netPnlUsd: number
  avgR: number
  bestR: number
  worstR: number
}

export function computeStats(history: PaperTrade[]): PaperStats {
  const closed = history.filter((t) => t.outcome)
  const rs = closed.map((t) => t.pnlR ?? 0)
  const wins = closed.filter((t) => (t.pnlR ?? 0) > 0).length
  const losses = closed.length - wins
  const netR = rs.reduce((a, b) => a + b, 0)
  const netRoiPct = closed.reduce((a, t) => a + (t.pnlPct ?? 0), 0)
  const netPnlUsd = closed.reduce((a, t) => a + (t.margin * ((t.pnlPct ?? 0) / 100)), 0)
  return {
    total: closed.length,
    wins,
    losses,
    winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
    netR: Number(netR.toFixed(2)),
    netRoiPct: Number(netRoiPct.toFixed(1)),
    netPnlUsd: Number(netPnlUsd.toFixed(2)),
    avgR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
    bestR: rs.length ? Number(Math.max(...rs).toFixed(2)) : 0,
    worstR: rs.length ? Number(Math.min(...rs).toFixed(2)) : 0,
  }
}
