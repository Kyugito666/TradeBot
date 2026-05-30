import type {
  Agent,
  Consensus,
  LogEvent,
  MarketRow,
  Performance,
  Position,
  RiskMetrics,
  Snapshot,
  TrendState,
  WhaleBias,
  SignalStatus,
} from "./types"

// Deterministic-ish pseudo random so first paint is stable, then it evolves live.
function rng(seed: number) {
  let s = seed % 2147483647
  if (s <= 0) s += 2147483646
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

const SYMBOLS = [
  { symbol: "BTCUSDT", price: 76535.9 },
  { symbol: "ETHUSDT", price: 4128.4 },
  { symbol: "SOLUSDT", price: 214.7 },
  { symbol: "BNBUSDT", price: 712.3 },
  { symbol: "XRPUSDT", price: 2.41 },
  { symbol: "DOGEUSDT", price: 0.3821 },
  { symbol: "AVAXUSDT", price: 48.9 },
  { symbol: "LINKUSDT", price: 27.66 },
]

// The committee of specialist agents (Jim Simons / RenTech style consensus engine).
const AGENT_DEFS: Omit<Agent, "vote" | "confidence" | "note">[] = [
  { id: "physicist", name: "Physicist", role: "Mean-reversion / microstructure", weight: 0.22, canVeto: true },
  { id: "statistician", name: "Statistician", role: "Stat-arb correlation", weight: 0.2, canVeto: false },
  { id: "cryptographer", name: "Cryptographer", role: "On-chain flow", weight: 0.16, canVeto: false },
  { id: "astronomer", name: "Astronomer", role: "Macro regime detection", weight: 0.14, canVeto: false },
  { id: "topologist", name: "Topologist", role: "Pattern / momentum", weight: 0.16, canVeto: false },
  { id: "risk-officer", name: "Risk Officer", role: "Exposure & limits", weight: 0.12, canVeto: true },
]

function spark(seed: number, base: number, vol: number): number[] {
  const r = rng(seed)
  const out: number[] = []
  let v = base
  for (let i = 0; i < 40; i++) {
    v += (r() - 0.5) * vol
    out.push(Number(v.toFixed(4)))
  }
  return out
}

function trendFromSpark(s: number[]): TrendState {
  const d = s[s.length - 1] - s[0]
  const rel = d / s[0]
  if (rel > 0.004) return "BULLISH"
  if (rel < -0.004) return "BEARISH"
  return "NEUTRAL"
}

function buildMarket(seed: number): MarketRow[] {
  const r = rng(seed)
  return SYMBOLS.map((s, i) => {
    const sp = spark(seed + i * 7, s.price, s.price * 0.0025)
    const trend = trendFromSpark(sp)
    const pct = (sp[sp.length - 1] / sp[0] - 1) * 100
    const lsr = 0.7 + r() * 1.1
    const whale: WhaleBias = lsr > 1.15 ? "LONG_HEAVY" : lsr < 0.9 ? "SHORT_HEAVY" : "BALANCED"
    const conf = Number((r() * 0.9).toFixed(3))
    let sig: SignalStatus = "WAIT"
    if (conf > 0.62 && trend === "BULLISH") sig = "LONG"
    else if (conf > 0.62 && trend === "BEARISH") sig = "SHORT"
    return {
      symbol: s.symbol,
      lastPrice: sp[sp.length - 1],
      pct24h: Number(pct.toFixed(2)),
      openInterest: Number((20000 + r() * 60000).toFixed(2)),
      lsrVal: Number(lsr.toFixed(3)),
      trendState: trend,
      whaleBias: whale,
      signalStatus: sig,
      confidence: conf,
      spark: sp,
    }
  })
}

function buildConsensus(seed: number, focus: MarketRow): Consensus {
  const r = rng(seed + 999)
  const agents: Agent[] = AGENT_DEFS.map((a, i) => {
    const rv = r()
    let vote: Agent["vote"]
    if (a.id === "physicist" && rv > 0.78) vote = "VETO"
    else if (focus.trendState === "BULLISH") vote = rv > 0.3 ? "LONG" : rv > 0.12 ? "WAIT" : "SHORT"
    else if (focus.trendState === "BEARISH") vote = rv > 0.3 ? "SHORT" : rv > 0.12 ? "WAIT" : "LONG"
    else vote = rv > 0.6 ? (rv > 0.8 ? "LONG" : "SHORT") : "WAIT"
    const notes: Record<string, string> = {
      physicist: vote === "VETO" ? "False breakout: extreme wick rejection detected" : "Order-flow imbalance within tolerance",
      statistician: "Pair z-score " + (r() * 3 - 1.5).toFixed(2) + "σ vs basket",
      cryptographer: focus.whaleBias === "LONG_HEAVY" ? "Net inflow to accumulation wallets" : "Exchange inflow rising",
      astronomer: "Regime: " + (focus.trendState === "BULLISH" ? "risk-on expansion" : "compression"),
      topologist: "Momentum slope " + (r() * 2 - 1).toFixed(2),
      "risk-officer": "Exposure " + (r() * 40 + 10).toFixed(0) + "% of cap",
    }
    return {
      ...a,
      vote,
      confidence: Number((0.4 + r() * 0.55).toFixed(3)),
      note: notes[a.id] ?? "",
    }
  })

  const vetoed = agents.some((a) => a.canVeto && a.vote === "VETO")
  let action: SignalStatus = "WAIT"
  let confidence = 0
  if (!vetoed) {
    let longW = 0
    let shortW = 0
    agents.forEach((a) => {
      if (a.vote === "LONG") longW += a.weight * a.confidence
      else if (a.vote === "SHORT") shortW += a.weight * a.confidence
    })
    confidence = Number(Math.abs(longW - shortW).toFixed(3))
    if (confidence > 0.18) action = longW > shortW ? "LONG" : "SHORT"
  }

  const reason = vetoed
    ? "VETO TRIGGERED: Physicist detected false breakout (extreme wick rejection)."
    : action === "WAIT"
      ? `Consensus: WAIT (conf=${confidence})`
      : `Consensus: ${action} (conf=${confidence})`

  const px = focus.lastPrice
  const dir = action === "SHORT" ? -1 : 1
  return {
    symbol: focus.symbol,
    action,
    confidence,
    reason,
    vetoed,
    agents,
    entryTarget: Number(px.toFixed(2)),
    tpTarget: Number((px * (1 + dir * 0.021)).toFixed(2)),
    slTarget: Number((px * (1 - dir * 0.011)).toFixed(2)),
  }
}

function buildPositions(seed: number, market: MarketRow[]): Position[] {
  const r = rng(seed + 444)
  const picks = market.slice(0, 4)
  return picks.map((m, i) => {
    const side = m.trendState === "BEARISH" ? "SHORT" : "LONG"
    const lev = [3, 5, 10, 5][i]
    const entry = m.lastPrice * (1 - (side === "LONG" ? 1 : -1) * (0.004 + r() * 0.02))
    const mark = m.lastPrice
    const dir = side === "LONG" ? 1 : -1
    const size = Number(((2000 + r() * 9000) / mark).toFixed(4))
    const notional = Number((size * mark).toFixed(2))
    const uPct = ((mark - entry) / entry) * 100 * dir * 1
    const unreal = Number((notional * (uPct / 100)).toFixed(2))
    return {
      id: "P" + (1000 + i),
      symbol: m.symbol,
      side,
      size,
      notional,
      entry: Number(entry.toFixed(2)),
      mark: Number(mark.toFixed(2)),
      liq: Number((entry * (1 - dir / lev) * 0.96).toFixed(2)),
      leverage: lev,
      unrealized: unreal,
      unrealizedPct: Number((uPct * lev).toFixed(2)),
      tp: Number((entry * (1 + dir * 0.03)).toFixed(2)),
      sl: Number((entry * (1 - dir * 0.015)).toFixed(2)),
      openedAt: ["00:42:11", "01:05:33", "01:48:02", "02:12:50"][i],
    }
  })
}

function buildPerf(seed: number): Performance {
  const r = rng(seed + 222)
  const curve = []
  let eq = 100000
  let bm = 100000
  for (let i = 0; i < 90; i++) {
    eq *= 1 + (r() - 0.44) * 0.018
    bm *= 1 + (r() - 0.49) * 0.02
    curve.push({
      t: `D${i + 1}`,
      equity: Number(eq.toFixed(0)),
      benchmark: Number(bm.toFixed(0)),
    })
  }
  const total = (eq / 100000 - 1) * 100
  return {
    curve,
    totalReturnPct: Number(total.toFixed(2)),
    todayPct: Number((r() * 4 - 1).toFixed(2)),
    weekPct: Number((r() * 9 - 2).toFixed(2)),
    monthPct: Number((r() * 18 - 3).toFixed(2)),
    winRate: Number((54 + r() * 14).toFixed(1)),
    profitFactor: Number((1.4 + r() * 1.1).toFixed(2)),
    trades: Math.floor(800 + r() * 1400),
    avgWin: Number((220 + r() * 300).toFixed(0)),
    avgLoss: Number((-(120 + r() * 180)).toFixed(0)),
    bestDay: Number((3 + r() * 5).toFixed(2)),
    worstDay: Number((-(2 + r() * 4)).toFixed(2)),
  }
}

function buildRisk(seed: number, positions: Position[], perf: Performance): RiskMetrics {
  const r = rng(seed + 333)
  const equity = perf.curve[perf.curve.length - 1].equity
  const gross = positions.reduce((a, p) => a + p.notional, 0)
  const net = positions.reduce((a, p) => a + (p.side === "LONG" ? p.notional : -p.notional), 0)
  const marginUsed = positions.reduce((a, p) => a + p.notional / p.leverage, 0)
  return {
    equity,
    marginUsed: Number(marginUsed.toFixed(0)),
    marginFree: Number((equity - marginUsed).toFixed(0)),
    marginRatio: Number((marginUsed / equity).toFixed(3)),
    netExposure: Number(net.toFixed(0)),
    grossExposure: Number(gross.toFixed(0)),
    maxDrawdown: Number((-(8 + r() * 10)).toFixed(2)),
    currentDrawdown: Number((-(r() * 6)).toFixed(2)),
    sharpe: Number((1.6 + r() * 1.4).toFixed(2)),
    sortino: Number((2.1 + r() * 1.8).toFixed(2)),
    valueAtRisk: Number((-(gross * 0.04)).toFixed(0)),
    dailyLossLimit: -5000,
    dailyPnl: Number((perf.todayPct / 100 * equity).toFixed(0)),
    openPositions: positions.length,
    killSwitchArmed: true,
  }
}

const LOG_SEED: LogEvent[] = [
  { id: "L1", time: "02:14:58", level: "VETO", symbol: "BTCUSDT", message: "Physicist veto: false breakout, wick rejection extreme" },
  { id: "L2", time: "02:14:02", level: "SIGNAL", symbol: "SOLUSDT", message: "Consensus LONG conf=0.71, whale LONG_HEAVY" },
  { id: "L3", time: "02:13:40", level: "EXEC", symbol: "SOLUSDT", message: "Filled LONG 18.4 @ 214.62, lev 10x" },
  { id: "L4", time: "02:12:10", level: "RISK", message: "Gross exposure 38% of cap — within limits" },
  { id: "L5", time: "02:10:55", level: "SIGNAL", symbol: "ETHUSDT", message: "Consensus WAIT conf=0.09" },
  { id: "L6", time: "02:09:21", level: "EXEC", symbol: "AVAXUSDT", message: "TP hit @ 49.88, +2.1% realized" },
  { id: "L7", time: "02:08:00", level: "INFO", message: "Cycle 4471 complete, latency 38ms" },
]

let cycleCounter = 4471
let logCounter = 100

export function buildSnapshot(seed = 42, mode: Snapshot["mode"] = "RUNNING"): Snapshot {
  const market = buildMarket(seed)
  const focus = market[0]
  const consensus = buildConsensus(seed, focus)
  const positions = buildPositions(seed, market)
  const performance = buildPerf(seed)
  const risk = buildRisk(seed, positions, performance)
  return {
    mode,
    uptimeSec: 8521,
    cycle: cycleCounter,
    latencyMs: 38,
    market,
    consensus,
    positions,
    risk,
    performance,
    log: LOG_SEED,
  }
}

// Produce the next live tick from a previous snapshot.
export function nextTick(prev: Snapshot): Snapshot {
  const seed = Math.floor(Math.random() * 2_000_000) + 1
  const r = rng(seed)
  cycleCounter += 1

  // jitter prices and roll sparklines
  const market: MarketRow[] = prev.market.map((m) => {
    const drift = (r() - 0.5) * m.lastPrice * 0.0016
    const next = Number((m.lastPrice + drift).toFixed(m.lastPrice < 1 ? 4 : 2))
    const sp = [...m.spark.slice(1), next]
    const trend = trendFromSpark(sp)
    const pct = Number((m.pct24h + (r() - 0.5) * 0.08).toFixed(2))
    return { ...m, lastPrice: next, spark: sp, trendState: trend, pct24h: pct }
  })

  // update positions mark + pnl
  const positions = prev.positions.map((p) => {
    const m = market.find((x) => x.symbol === p.symbol)
    const mark = m ? m.lastPrice : p.mark
    const dir = p.side === "LONG" ? 1 : -1
    const uPct = ((mark - p.entry) / p.entry) * 100 * dir
    return {
      ...p,
      mark,
      unrealized: Number((p.notional * (uPct / 100)).toFixed(2)),
      unrealizedPct: Number((uPct * p.leverage).toFixed(2)),
    }
  })

  // occasionally push a new log line
  let log = prev.log
  if (r() > 0.55) {
    logCounter += 1
    const m = market[Math.floor(r() * market.length)]
    const levels: LogEvent["level"][] = ["SIGNAL", "EXEC", "RISK", "INFO", "VETO"]
    const level = levels[Math.floor(r() * levels.length)]
    const msgs: Record<string, string> = {
      SIGNAL: `Consensus ${m.signalStatus} conf=${m.confidence}`,
      EXEC: `Filled ${m.signalStatus === "SHORT" ? "SHORT" : "LONG"} @ ${m.lastPrice}`,
      RISK: `Margin ratio ${(prev.risk.marginRatio * 100).toFixed(0)}% — within limits`,
      INFO: `Cycle ${cycleCounter} complete, latency ${30 + Math.floor(r() * 20)}ms`,
      VETO: "Physicist veto: false breakout filtered",
    }
    const evt: LogEvent = {
      id: "L" + logCounter,
      time: new Date().toLocaleTimeString("en-GB"),
      level,
      symbol: level === "RISK" || level === "INFO" ? undefined : m.symbol,
      message: msgs[level],
    }
    log = [evt, ...prev.log].slice(0, 30)
  }

  const consensus = buildConsensus(seed, market[0])
  const perf = prev.performance
  const risk = buildRisk(seed, positions, perf)

  return {
    ...prev,
    cycle: cycleCounter,
    latencyMs: 30 + Math.floor(r() * 22),
    uptimeSec: prev.uptimeSec + 2,
    market,
    positions,
    consensus,
    risk: { ...risk, killSwitchArmed: prev.risk.killSwitchArmed },
    log,
  }
}
