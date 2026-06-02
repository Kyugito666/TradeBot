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
const STYLE_MIN_CONFIDENCE: Record<TradingStyle, number> = {
  scalp: 0.45,
  intraday: 0.35,
  swing: 0.3,
}

export function styleConfidenceGate(style: TradingStyle): number {
  return STYLE_MIN_CONFIDENCE[style] ?? 0.35
}

export function passesFilter(row: MarketRow, style: TradingStyle): boolean {
  if (row.signalStatus !== "LONG" && row.signalStatus !== "SHORT") return false
  return row.confidence >= styleConfidenceGate(style)
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
  const avg = n > 0 ? sumAbs / n : 0.012
  // Clamp to a sane band so a flat or spiky spark can't produce absurd levels.
  return Math.min(0.08, Math.max(0.003, avg))
}

// ── Resolve leverage for a pair from the active CEX config ────────────────────
export function resolveLeverage(symbol: string, cex: CexConfig | undefined): number {
  if (!cex) return 5
  const override = cex.pairLeverage.find((p) => p.pair.toUpperCase() === symbol.toUpperCase())
  return override?.leverage ?? cex.defaultLeverage
}

function round(value: number, price: number): number {
  const digits = price < 1 ? 5 : 2
  return Number(value.toFixed(digits))
}

// ── Compute Entry / TP / SL for a row using the risk preset + active CEX ──────
export function computeLevels(row: MarketRow, risk: RiskModel, cex: CexConfig | undefined): SignalLevels {
  const side: SignalSide = row.signalStatus === "SHORT" ? "SHORT" : "LONG"
  const last = row.lastPrice
  const atrPct = sparkAtrPct(row.spark, last)

  const slDistPct = atrPct * risk.atrMultiplier
  const tpDistPct = slDistPct * risk.riskReward
  const leverage = resolveLeverage(row.symbol, cex)

  let entry = last
  let tp = last
  let sl = last
  if (side === "LONG") {
    tp = entry * (1 + tpDistPct)
    sl = entry * (1 - slDistPct)
  } else {
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
  openedAt: number
  reason: string
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
  return {
    total: closed.length,
    wins,
    losses,
    winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
    netR: Number(netR.toFixed(2)),
    netRoiPct: Number(netRoiPct.toFixed(1)),
    avgR: closed.length ? Number((netR / closed.length).toFixed(3)) : 0,
    bestR: rs.length ? Number(Math.max(...rs).toFixed(2)) : 0,
    worstR: rs.length ? Number(Math.min(...rs).toFixed(2)) : 0,
  }
}
