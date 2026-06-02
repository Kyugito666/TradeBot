"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  Database,
  Gauge,
  History,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  SkipForward,
  Square,
  Trash2,
} from "lucide-react"
import { Panel, Tag, Meter } from "./ui-kit"
import { cn } from "@/lib/utils"
import { num, usd } from "@/lib/format"
import type { BacktestResult, ReplayChart, ReplayMarker } from "@/lib/backtest"
import type { TradingSettings } from "@/hooks/use-live-data"

// How many candles the replay cursor advances per tick.
const STEP_OPTIONS = [1, 2, 5, 10, 25] as const
// Playback speed multipliers — higher = faster bar-to-bar stepping.
const SPEED_OPTIONS = [0.5, 1, 2, 4, 8] as const
// Base tick delay (ms) at 1× before the speed multiplier is applied.
const BASE_TICK_MS = 240
// How many candles are visible in the chart window at once (TradingView-style scroll).
const VISIBLE_BARS = 90

type ReplayPhase = "idle" | "loading" | "running" | "paused" | "done"

export function BacktestPanel({
  backtests,
  isBacktesting,
  runBacktest,
  clearBacktests,
  tradingSettings,
}: {
  backtests: BacktestResult[]
  isBacktesting: boolean
  runBacktest: () => Promise<BacktestResult>
  clearBacktests: () => void
  /** Read-only — sourced from the Mode & Settings tab (no duplicate inputs here). */
  tradingSettings: TradingSettings
}) {
  // ── Replay setup (the only settings owned by this tab) ──
  const [stepInterval, setStepInterval] = useState<number>(1)
  const [speed, setSpeed] = useState<number>(1)

  // ── Replay runtime ──
  const [phase, setPhase] = useState<ReplayPhase>("idle")
  const [active, setActive] = useState<BacktestResult | null>(null)
  const [bar, setBar] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const startGuard = useRef(false)

  const activeCex = tradingSettings.cexes.find((c) => c.id === tradingSettings.activeCex)
  const riskReward = tradingSettings.riskModel.riskReward
  const replay = active?.replay ?? null
  const totalBars = replay ? replay.bars.length : 0
  const startBar = replay ? Math.min(replay.warmup, Math.max(0, totalBars - 1)) : 0
  const lastBar = Math.max(0, totalBars - 1)
  const atEnd = totalBars > 0 && bar >= lastBar

  // Drive the step-by-step playback. Each tick advances the candle cursor by the
  // chosen interval; the delay shrinks as the speed multiplier rises, so it
  // genuinely "runs" through historical bars like a TradingView replay.
  useEffect(() => {
    if (phase !== "running" || !replay) return
    if (bar >= lastBar) {
      setPhase("done")
      return
    }
    const delay = Math.max(20, BASE_TICK_MS / speed)
    const id = setTimeout(() => {
      setBar((b) => Math.min(lastBar, b + stepInterval))
    }, delay)
    return () => clearTimeout(id)
  }, [phase, bar, replay, lastBar, speed, stepInterval])

  // Progressive view of the run up to the current bar — stats "build" live as
  // trades on the headline pair close out.
  const view = useMemo(() => {
    if (!replay) return null
    const realized = replay.markers
      .filter((m) => m.exitBar <= bar)
      .sort((a, b) => a.exitBar - b.exitBar)
    const open = replay.markers.find((m) => m.entryBar <= bar && m.exitBar > bar) ?? null

    let balance = replay.initialBalance
    let peak = balance
    let maxDd = 0
    let wins = 0
    let losses = 0
    for (const m of realized) {
      const r = m.outcome === "TP" ? riskReward : -1
      balance += balance * replay.riskPerTrade * r
      if (m.outcome === "TP") wins++
      else losses++
      if (balance > peak) peak = balance
      const dd = peak > 0 ? (peak - balance) / peak : 0
      if (dd > maxDd) maxDd = dd
    }
    const trades = realized.length
    const netPct =
      replay.initialBalance > 0 ? ((balance - replay.initialBalance) / replay.initialBalance) * 100 : 0
    const winRate = trades > 0 ? (wins / trades) * 100 : 0
    const barTime = replay.endTime - (lastBar - bar) * replay.intervalMs
    return { realized, open, balance, peak, maxDd: maxDd * 100, wins, losses, trades, netPct, winRate, barTime }
  }, [replay, bar, riskReward, lastBar])

  async function handleStart() {
    if (startGuard.current) return
    startGuard.current = true
    setError(null)
    setPhase("loading")
    try {
      const result = await runBacktest()
      setActive(result)
      const rep = result.replay
      if (rep && rep.bars.length > rep.warmup + 1) {
        setBar(Math.min(rep.warmup, rep.bars.length - 1))
        setPhase("running")
      } else {
        setBar(rep ? rep.bars.length - 1 : 0)
        setPhase("done")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backtest failed")
      setPhase("idle")
    } finally {
      startGuard.current = false
    }
  }

  function replayAgain() {
    if (!replay) return
    setBar(startBar)
    setPhase(totalBars > startBar + 1 ? "running" : "done")
  }

  const progress = lastBar > startBar ? (bar - startBar) / (lastBar - startBar) : phase === "done" ? 1 : 0
  const running = phase === "running"
  const paused = phase === "paused"
  const loading = phase === "loading" || isBacktesting

  const phaseTag =
    phase === "running"
      ? { tone: "primary" as const, label: "REPLAYING" }
      : phase === "paused"
        ? { tone: "warning" as const, label: "PAUSED" }
        : phase === "loading"
          ? { tone: "warning" as const, label: "PREPARING" }
          : phase === "done"
            ? { tone: "positive" as const, label: "DONE" }
            : { tone: "muted" as const, label: "READY" }

  return (
    <Panel
      title="Backtest Replay (Live-Running)"
      right={
        <div className="flex items-center gap-2">
          <Tag tone={phaseTag.tone}>{phaseTag.label}</Tag>
          <Tag tone="outline">
            <Database className="h-3 w-3" />
            {backtests.length} SAVED
          </Tag>
        </div>
      }
    >
      <div className="space-y-3 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Replays a real backtest candle-by-candle on live historical data, like a TradingView replay. Mode, style,
          leverage and risk are read straight from the{" "}
          <span className="font-semibold text-foreground">Mode &amp; Settings</span> tab — set the{" "}
          <span className="font-semibold text-foreground">step interval</span> and{" "}
          <span className="font-semibold text-foreground">playback speed</span> below, then press Start to watch it run.
        </p>

        {/* ── Read-only config — sourced from Mode & Settings (no duplicate inputs) ── */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Settings2 className="h-3 w-3" />
            From Settings
          </span>
          <Tag tone="outline">{activeCex?.label ?? tradingSettings.activeCex}</Tag>
          <Tag tone="outline">MODE {activeCex?.marginMode?.toUpperCase() ?? "—"}</Tag>
          <Tag tone="outline">STYLE {tradingSettings.tradingStyle.toUpperCase()}</Tag>
          <Tag tone="outline">LEV {activeCex?.defaultLeverage ?? "—"}×</Tag>
          <Tag tone="primary">RISK {tradingSettings.riskModel.preset.toUpperCase()}</Tag>
          <Tag tone="muted">RR 1:{tradingSettings.riskModel.riskReward}</Tag>
        </div>

        {/* ── Replay setup: step interval + playback speed ── */}
        <div className="grid grid-cols-1 gap-3 rounded-md border border-border bg-background p-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <SkipForward className="h-3 w-3" />
              Step Interval
              <span className="text-muted-foreground/70">(bars / step)</span>
            </span>
            <div className="flex flex-wrap gap-1">
              {STEP_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStepInterval(s)}
                  disabled={running || paused || loading}
                  className={cn(
                    "min-w-9 rounded border px-2 py-1 font-mono text-xs font-semibold transition-colors",
                    stepInterval === s
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary",
                    (running || paused || loading) && "cursor-not-allowed opacity-50",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Gauge className="h-3 w-3" />
              Playback Speed
            </span>
            <div className="flex flex-wrap gap-1">
              {SPEED_OPTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSpeed(s)}
                  disabled={loading}
                  className={cn(
                    "min-w-9 rounded border px-2 py-1 font-mono text-xs font-semibold transition-colors",
                    speed === s
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary",
                    loading && "cursor-not-allowed opacity-50",
                  )}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Transport controls ── */}
        <div className="flex flex-wrap items-center gap-2">
          {(phase === "idle" || phase === "done") && (
            <button
              onClick={handleStart}
              disabled={loading}
              className={cn(
                "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors",
                loading
                  ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
                  : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
              )}
            >
              <Play className="h-3.5 w-3.5" />
              {loading ? "Preparing…" : phase === "done" ? "New Replay" : "Start Replay"}
            </button>
          )}

          {phase === "done" && replay && totalBars > startBar + 1 && (
            <button
              onClick={replayAgain}
              className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Replay Again
            </button>
          )}

          {running && (
            <button
              onClick={() => setPhase("paused")}
              className="flex items-center gap-1.5 rounded border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs font-semibold text-warning transition-colors hover:bg-warning/20"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </button>
          )}

          {paused && (
            <button
              onClick={() => setPhase("running")}
              className="flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </button>
          )}

          {(running || paused) && (
            <button
              onClick={() => {
                setBar(lastBar)
                setPhase("done")
              }}
              className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-negative/50 hover:text-negative"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          )}

          <div className="ml-auto flex items-center gap-2">
            {backtests.length > 0 && (
              <button
                onClick={clearBacktests}
                disabled={running || paused || loading}
                className={cn(
                  "flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-negative/50 hover:text-negative",
                  (running || paused || loading) && "cursor-not-allowed opacity-50",
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>

        {error && (
          <p className="rounded border border-negative/40 bg-negative/10 px-2.5 py-2 text-[11px] text-negative">
            {error}
          </p>
        )}

        {/* ── Live replay surface ── */}
        {active && replay && view && (
          <div className="space-y-3 rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-bold text-foreground">{replay.symbol}</span>
                <Tag tone="muted">1H</Tag>
                <Tag tone="outline">{replay.leverage}×</Tag>
                {view.open && (
                  <Tag tone={view.open.side === "LONG" ? "positive" : "negative"}>{view.open.side} OPEN</Tag>
                )}
              </div>
              <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                <span>
                  bar {Math.max(0, bar - startBar)} / {Math.max(0, lastBar - startBar)}
                </span>
                <Tag tone={view.netPct >= 0 ? "positive" : "negative"}>
                  {view.netPct >= 0 ? "+" : ""}
                  {view.netPct.toFixed(2)}%
                </Tag>
              </div>
            </div>

            {/* Period / time axis — moves as the replay runs */}
            <div className="flex items-center justify-between font-mono text-[10px] text-muted-foreground">
              <span>
                Period:{" "}
                <span className="text-foreground">
                  {fmtTime(view.barTime - Math.min(VISIBLE_BARS - 1, bar) * replay.intervalMs)}
                </span>
              </span>
              <span>
                Now: <span className="text-foreground">{fmtTime(view.barTime)}</span>
              </span>
            </div>

            {/* Live candlestick chart */}
            <CandleChart replay={replay} bar={bar} open={view.open} />

            <Meter value={progress} tone={running ? "primary" : view.netPct >= 0 ? "positive" : "warning"} />

            {/* Progressive stats — they accumulate as the replay runs */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Balance" value={usd(view.balance)} tone={view.netPct >= 0 ? "positive" : "negative"} />
              <Stat label="Trades" value={num(view.trades, 0)} />
              <Stat label="Win Rate" value={`${view.winRate.toFixed(1)}%`} />
              <Stat label="Max Drawdown" value={`${view.maxDd.toFixed(2)}%`} tone="negative" />
              <Stat label="Wins" value={num(view.wins, 0)} tone="positive" />
              <Stat label="Losses" value={num(view.losses, 0)} tone="negative" />
              <Stat label="Portfolio PF" value={atEnd ? String(active.profitFactor) : "…"} />
              <Stat label="Margin" value={`${active.marginUsagePct}% ${active.marginMode}`} />
            </div>

            {atEnd && (
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Chart shows the most active pair ({replay.symbol}). Full portfolio result across{" "}
                {active.scannedPairs} pairs: {active.trades} trades · {active.winRate}% win ·{" "}
                <span className={active.netPnlPct >= 0 ? "text-positive" : "text-negative"}>
                  {active.netPnlPct >= 0 ? "+" : ""}
                  {active.netPnlPct}%
                </span>{" "}
                net.
              </p>
            )}
          </div>
        )}

        {/* ── Saved history ── */}
        {backtests.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <History className="h-3 w-3" />
              History
            </div>
            <div className="max-h-40 space-y-1 overflow-y-auto scroll-thin">
              {backtests.map((bt) => (
                <div
                  key={bt.id}
                  className="flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5 text-[11px]"
                >
                  <span className="text-muted-foreground">{new Date(bt.ranAt).toLocaleString("en-US")}</span>
                  <span className="font-mono">
                    {bt.cexLabel} · {bt.style}
                  </span>
                  <span
                    className={cn("font-mono font-semibold", bt.netPnlPct >= 0 ? "text-positive" : "text-negative")}
                  >
                    {bt.netPnlPct >= 0 ? "+" : ""}
                    {bt.netPnlPct}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!active && !loading && (
          <p className="rounded border border-dashed border-border px-2.5 py-6 text-center text-[11px] text-muted-foreground">
            Configure your strategy in the Mode &amp; Settings tab, pick a step interval and speed above, then press
            Start Replay to run it live.
          </p>
        )}
      </div>
    </Panel>
  )
}

function fmtTime(ms: number) {
  const d = new Date(ms)
  return d.toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// ── Canvas candlestick chart that "plays" up to the current bar ──────────────
function CandleChart({
  replay,
  bar,
  open,
}: {
  replay: ReplayChart
  bar: number
  open: ReplayMarker | null
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const cssW = wrap.clientWidth
    const cssH = 220
    canvas.width = Math.floor(cssW * dpr)
    canvas.height = Math.floor(cssH * dpr)
    canvas.style.width = `${cssW}px`
    canvas.style.height = `${cssH}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cssW, cssH)

    const css = (name: string, fallback: string) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      return v ? `hsl(${v})` : fallback
    }
    const colUp = css("--positive", "#16a34a")
    const colDown = css("--negative", "#dc2626")
    const colBorder = css("--border", "#27272a")
    const colMuted = css("--muted-foreground", "#71717a")

    const padL = 6
    const padR = 52
    const padT = 8
    const padB = 8
    const plotW = cssW - padL - padR
    const plotH = cssH - padT - padB

    // Visible window: the last VISIBLE_BARS candles ending at the current bar.
    const end = Math.max(0, Math.min(bar, replay.bars.length - 1))
    const start = Math.max(0, end - VISIBLE_BARS + 1)
    const slice = replay.bars.slice(start, end + 1)
    if (slice.length === 0) return

    let hi = -Infinity
    let lo = Infinity
    for (const b of slice) {
      if (b.h > hi) hi = b.h
      if (b.l < lo) lo = b.l
    }
    // Include any visible trade levels so markers stay on-screen.
    for (const m of replay.markers) {
      if (m.entryBar >= start && m.entryBar <= end) {
        hi = Math.max(hi, m.entry, m.exit)
        lo = Math.min(lo, m.entry, m.exit)
      }
    }
    const range = hi - lo || 1
    const pad = range * 0.08
    hi += pad
    lo -= pad
    const span = hi - lo || 1

    const n = slice.length
    const slot = plotW / Math.max(VISIBLE_BARS, n)
    const bodyW = Math.max(1, slot * 0.62)
    const xOf = (i: number) => padL + i * slot + slot / 2
    const yOf = (price: number) => padT + (1 - (price - lo) / span) * plotH

    // Horizontal grid + price labels
    ctx.strokeStyle = colBorder
    ctx.fillStyle = colMuted
    ctx.lineWidth = 1
    ctx.font = "9px ui-monospace, monospace"
    ctx.textBaseline = "middle"
    const GRID = 4
    for (let g = 0; g <= GRID; g++) {
      const price = lo + (span * g) / GRID
      const y = yOf(price)
      ctx.globalAlpha = 0.35
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillText(fmtPrice(price), padL + plotW + 4, y)
    }

    // Candles
    for (let i = 0; i < n; i++) {
      const b = slice[i]
      const up = b.c >= b.o
      const color = up ? colUp : colDown
      const x = xOf(i)
      ctx.strokeStyle = color
      ctx.fillStyle = color
      ctx.lineWidth = 1
      // wick
      ctx.beginPath()
      ctx.moveTo(x, yOf(b.h))
      ctx.lineTo(x, yOf(b.l))
      ctx.stroke()
      // body
      const yO = yOf(b.o)
      const yC = yOf(b.c)
      const top = Math.min(yO, yC)
      const h = Math.max(1, Math.abs(yC - yO))
      ctx.fillRect(x - bodyW / 2, top, bodyW, h)
    }

    // Trade markers (entry/exit) within the window
    for (const m of replay.markers) {
      if (m.exitBar < start || m.entryBar > end) continue
      const long = m.side === "LONG"
      const mColor = m.outcome === "TP" ? colUp : colDown
      // entry marker
      if (m.entryBar >= start && m.entryBar <= end) {
        const x = xOf(m.entryBar - start)
        const y = yOf(m.entry)
        ctx.fillStyle = long ? colUp : colDown
        ctx.beginPath()
        if (long) {
          ctx.moveTo(x, y + 7)
          ctx.lineTo(x - 4, y + 13)
          ctx.lineTo(x + 4, y + 13)
        } else {
          ctx.moveTo(x, y - 7)
          ctx.lineTo(x - 4, y - 13)
          ctx.lineTo(x + 4, y - 13)
        }
        ctx.closePath()
        ctx.fill()
      }
      // exit marker (only once the bar has been reached)
      if (m.exitBar >= start && m.exitBar <= end && m.exitBar <= bar) {
        const x = xOf(m.exitBar - start)
        const y = yOf(m.exit)
        ctx.strokeStyle = mColor
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(x, y, 3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // Active open-trade entry line
    if (open && open.entryBar <= end) {
      const y = yOf(open.entry)
      ctx.strokeStyle = open.side === "LONG" ? colUp : colDown
      ctx.globalAlpha = 0.7
      ctx.setLineDash([4, 3])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + plotW, y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    // Last price line
    const lastClose = slice[slice.length - 1].c
    const yLast = yOf(lastClose)
    ctx.strokeStyle = colMuted
    ctx.globalAlpha = 0.6
    ctx.setLineDash([2, 2])
    ctx.beginPath()
    ctx.moveTo(padL, yLast)
    ctx.lineTo(padL + plotW, yLast)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1
    ctx.fillStyle = colMuted
    ctx.fillText(fmtPrice(lastClose), padL + plotW + 4, yLast)
  }, [replay, bar, open])

  return (
    <div ref={wrapRef} className="w-full overflow-hidden rounded border border-border bg-panel">
      <canvas ref={canvasRef} aria-label={`Candlestick replay of ${replay.symbol}`} />
    </div>
  )
}

function fmtPrice(p: number) {
  if (p >= 1000) return p.toFixed(0)
  if (p >= 1) return p.toFixed(2)
  return p.toFixed(5)
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "positive" | "negative"
}) {
  return (
    <div className="rounded border border-border bg-panel px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-mono text-sm font-bold",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
      </div>
    </div>
  )
}
