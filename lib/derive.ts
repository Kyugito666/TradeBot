import type {
  Consensus,
  EngineInsight,
  EngineLogLine,
  EnginePosition,
  LogEvent,
  MarketRow,
  Performance,
  Position,
  RiskMetrics,
  SignalStatus,
  TrendState,
  WhaleBias,
} from "./types"

export function mapTrend(s: string | undefined): TrendState {
  const u = (s || "").toUpperCase()
  if (u.includes("BULL")) return "BULLISH"
  if (u.includes("BEAR")) return "BEARISH"
  return "NEUTRAL"
}

export function mapWhale(s: string | undefined): WhaleBias {
  const u = (s || "").toUpperCase()
  if (u.includes("LONG")) return "LONG_HEAVY"
  if (u.includes("SHORT")) return "SHORT_HEAVY"
  return "BALANCED"
}

export function mapSignal(s: string | undefined): SignalStatus {
  const u = (s || "").toUpperCase()
  if (u.includes("LONG") || u.includes("BUY")) return "LONG"
  if (u.includes("SHORT") || u.includes("SELL")) return "SHORT"
  return "WAIT"
}

function mapSide(s: string): "LONG" | "SHORT" {
  const u = (s || "").toUpperCase()
  return u.includes("SHORT") || u.includes("SELL") ? "SHORT" : "LONG"
}

// Parse confidence out of advice strings like "Consensus: WAIT (conf=0.029)".
export function parseConfidence(advice: string | undefined): number {
  if (!advice) return 0
  const m = advice.match(/conf(?:idence)?\s*[=:]\s*([0-9]*\.?[0-9]+)/i)
  if (!m) return 0
  const v = Number(m[1])
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
}

export function buildConsensus(insight: EngineInsight | null): Consensus | null {
  if (!insight || !insight.symbol) return null
  return {
    symbol: insight.symbol,
    action: mapSignal(insight.signal_status),
    confidence: parseConfidence(insight.advice),
    reason: insight.advice || "Awaiting consensus from engine.",
    trendState: mapTrend(insight.trend_state),
    whaleBias: mapWhale(insight.whale_bias),
    entryTarget: insight.entry_target || 0,
    tpTarget: insight.tp_target || 0,
    slTarget: insight.sl_target || 0,
    updatedAt: insight.timestamp || "",
  }
}

export function buildPositions(active: EnginePosition[], market: MarketRow[]): Position[] {
  return (active || []).map((p, i) => {
    const side = mapSide(p.side)
    const mkt = market.find((m) => m.symbol === p.symbol)
    const mark = mkt?.lastPrice || p.entry_price
    const pnlPct = Number(p.pnl) || 0
    const margin = Number(p.margin) || 0
    return {
      id: `${p.symbol}-${p.time || i}`,
      symbol: p.symbol,
      side,
      entry: p.entry_price || 0,
      mark,
      tp: p.take_profit || 0,
      sl: p.stop_loss || 0,
      margin,
      pnlPct,
      pnlUsd: Number(((margin * pnlPct) / 100).toFixed(2)),
      status: p.status || "OPEN",
      openedAt: p.time || "",
    }
  })
}

export function buildPerformance(history: EnginePosition[], balance: number): Performance {
  const trades = (history || []).filter((h) => Number.isFinite(Number(h.pnl)))
  const realized = trades.map((h) => (Number(h.margin) * Number(h.pnl)) / 100)

  const wins = realized.filter((r) => r > 0)
  const losses = realized.filter((r) => r < 0)
  const grossWin = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
  const realizedPnl = realized.reduce((a, b) => a + b, 0)

  const baseline = Math.max(1, balance - realizedPnl)
  let eq = baseline
  const curve = realized.map((r, i) => {
    eq += r
    return { t: `T${i + 1}`, equity: Number(eq.toFixed(2)) }
  })
  // anchor the curve with its starting equity
  curve.unshift({ t: "T0", equity: Number(baseline.toFixed(2)) })

  return {
    curve,
    realizedPnl: Number(realizedPnl.toFixed(2)),
    totalReturnPct: baseline > 0 ? Number(((realizedPnl / baseline) * 100).toFixed(2)) : 0,
    todayPct: 0,
    winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? 99 : 0,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    avgWin: wins.length ? Number((grossWin / wins.length).toFixed(2)) : 0,
    avgLoss: losses.length ? Number((-grossLoss / losses.length).toFixed(2)) : 0,
    bestTrade: realized.length ? Number(Math.max(...realized).toFixed(2)) : 0,
    worstTrade: realized.length ? Number(Math.min(...realized).toFixed(2)) : 0,
  }
}

export function buildRisk(
  insight: EngineInsight | null,
  positions: Position[],
  perf: Performance,
): RiskMetrics {
  const balance = insight?.balance || 0
  const marginUsed = positions.reduce((a, p) => a + p.margin, 0)
  const unreal = positions.reduce((a, p) => a + p.pnlUsd, 0)
  const equity = balance + marginUsed + unreal
  const net = positions.reduce((a, p) => a + (p.side === "LONG" ? p.margin : -p.margin), 0)
  return {
    equity: Number(equity.toFixed(2)),
    balance: Number(balance.toFixed(2)),
    marginUsed: Number(marginUsed.toFixed(2)),
    marginFree: Number(balance.toFixed(2)),
    marginRatio: equity > 0 ? Number((marginUsed / equity).toFixed(3)) : 0,
    netExposure: Number(net.toFixed(2)),
    grossExposure: Number(marginUsed.toFixed(2)),
    dailyPnl: Number(unreal.toFixed(2)),
    openPositions: positions.length,
    dryRun: false,
  }
}

const LEVEL_MAP: Record<string, LogEvent["level"]> = {
  INFO: "INFO",
  SIGNAL: "SIGNAL",
  EXEC: "EXEC",
  RISK: "RISK",
  VETO: "VETO",
  WARN: "WARNING",
  WARNING: "WARNING",
  ERROR: "ERROR",
  DEBUG: "DEBUG",
}

export function mapLogs(lines: EngineLogLine[]): LogEvent[] {
  const out = (lines || []).map((l, i) => {
    const raw = (l.level || "INFO").toUpperCase()
    let level = LEVEL_MAP[raw] || "INFO"
    const msg = l.msg || ""
    const upper = msg.toUpperCase()
    if (level === "INFO") {
      if (upper.includes("VETO")) level = "VETO"
      else if (upper.includes("FILLED") || upper.includes("EXECUT") || upper.includes("ENTRY") || upper.includes("CLOSED")) level = "EXEC"
      else if (upper.includes("SIGNAL") || upper.includes("CONSENSUS")) level = "SIGNAL"
    }
    return {
      id: `log-${i}`,
      time: l.ts || "",
      level,
      name: l.name,
      message: msg,
    }
  })
  // newest first
  return out.reverse()
}
