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
import type { BacktestResult } from "@/lib/backtest"
import type { TradingSettings } from "@/hooks/use-live-data"

// How many equity-curve events the replay cursor advances per tick.
const STEP_OPTIONS = [1, 2, 5, 10, 25] as const
// Playback speed multipliers — higher = faster period-to-period stepping.
const SPEED_OPTIONS = [0.5, 1, 2, 4, 8] as const
// Base tick delay (ms) at 1× before the speed multiplier is applied.
const BASE_TICK_MS = 260

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
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const startGuard = useRef(false)

  const activeCex = tradingSettings.cexes.find((c) => c.id === tradingSettings.activeCex)
  const total = active ? active.equityCurve.length : 0
  const atEnd = total > 0 && cursor >= total - 1

  // Drive the step-by-step playback. Each tick advances the cursor by the chosen
  // interval; the delay between ticks shrinks as the speed multiplier rises, so it
  // genuinely "runs" through the historical periods like a TradingView replay.
  useEffect(() => {
    if (phase !== "running" || !active) return
    if (cursor >= total - 1) {
      setPhase("done")
      return
    }
    const delay = Math.max(24, BASE_TICK_MS / speed)
    const id = setTimeout(() => {
      setCursor((c) => Math.min(total - 1, c + stepInterval))
    }, delay)
    return () => clearTimeout(id)
  }, [phase, cursor, active, total, speed, stepInterval])

  // Progressive view of the run up to the current cursor — stats "build" live.
  const view = useMemo(() => {
    if (!active || total === 0) return null
    const curve = active.equityCurve.slice(0, cursor + 1)
    const balance = curve[curve.length - 1] ?? active.initialBalance
    let wins = 0
    let losses = 0
    let peak = curve[0] ?? active.initialBalance
    let maxDd = 0
    for (let i = 1; i < curve.length; i++) {
      const delta = curve[i] - curve[i - 1]
      if (delta >= 0) wins++
      else losses++
    }
    for (const b of curve) {
      if (b > peak) peak = b
      const dd = peak > 0 ? (peak - b) / peak : 0
      if (dd > maxDd) maxDd = dd
    }
    const trades = Math.max(0, curve.length - 1)
    const netPct =
      active.initialBalance > 0 ? ((balance - active.initialBalance) / active.initialBalance) * 100 : 0
    const winRate = trades > 0 ? (wins / trades) * 100 : 0
    return {
      curve,
      balance,
      wins,
      losses,
      trades,
      netPct,
      winRate,
      maxDd: maxDd * 100,
    }
  }, [active, cursor, total])

  async function handleStart() {
    if (startGuard.current) return
    startGuard.current = true
    setError(null)
    setPhase("loading")
    setCursor(0)
    try {
      const result = await runBacktest()
      setActive(result)
      setCursor(0)
      // A meaningful replay needs at least 2 equity points; otherwise just show it.
      setPhase(result.equityCurve.length > 1 ? "running" : "done")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backtest failed")
      setPhase("idle")
    } finally {
      startGuard.current = false
    }
  }

  function replayAgain() {
    if (!active) return
    setCursor(0)
    setPhase(active.equityCurve.length > 1 ? "running" : "done")
  }

  const progress = total > 1 ? cursor / (total - 1) : phase === "done" ? 1 : 0
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
          Replays a deterministic backtest period-by-period, like a TradingView replay. Mode, style, leverage and risk
          are read straight from the <span className="font-semibold text-foreground">Mode &amp; Settings</span> tab —
          set the <span className="font-semibold text-foreground">step interval</span> and{" "}
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
                  {s}×
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

          {phase === "done" && active && active.equityCurve.length > 1 && (
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
                setCursor(total > 0 ? total - 1 : 0)
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
        {active && view && (
          <div className="space-y-3 rounded-md border border-border bg-background p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-foreground">
                {active.cexLabel} · {active.style} · {active.dryRun ? "Dry-Run" : "Real"}
              </span>
              <div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
                <span>
                  step {Math.min(cursor, Math.max(0, total - 1))} / {Math.max(0, total - 1)}
                </span>
                <Tag tone={view.netPct >= 0 ? "positive" : "negative"}>
                  {view.netPct >= 0 ? "+" : ""}
                  {view.netPct.toFixed(2)}%
                </Tag>
              </div>
            </div>

            {/* Growing equity curve */}
            <EquityChart data={view.curve} baseline={active.initialBalance} />

            <Meter value={progress} tone={running ? "primary" : view.netPct >= 0 ? "positive" : "warning"} />

            {/* Progressive stats — they accumulate as the replay runs */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Balance" value={usd(view.balance)} tone={view.netPct >= 0 ? "positive" : "negative"} />
              <Stat label="Trades" value={num(view.trades, 0)} />
              <Stat label="Win Rate" value={`${view.winRate.toFixed(1)}%`} />
              <Stat label="Max Drawdown" value={`${view.maxDd.toFixed(2)}%`} tone="negative" />
              <Stat label="Wins" value={num(view.wins, 0)} tone="positive" />
              <Stat label="Losses" value={num(view.losses, 0)} tone="negative" />
              <Stat label="Profit Factor" value={atEnd ? String(active.profitFactor) : "…"} />
              <Stat label="Margin" value={`${active.marginUsagePct}% ${active.marginMode}`} />
            </div>
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

// Responsive equity line + fill that scales to the panel width as the run grows.
function EquityChart({ data, baseline }: { data: number[]; baseline: number }) {
  if (data.length < 2) {
    return (
      <div className="flex h-32 items-center justify-center rounded border border-border bg-panel text-[11px] text-muted-foreground">
        Waiting for the first periods…
      </div>
    )
  }
  const W = 100
  const H = 40
  const min = Math.min(...data, baseline)
  const max = Math.max(...data, baseline)
  const range = max - min || 1
  const x = (i: number) => (i / (data.length - 1)) * W
  const y = (v: number) => H - ((v - min) / range) * H
  const line = data.map((d, i) => `${x(i).toFixed(2)},${y(d).toFixed(2)}`).join(" ")
  const area = `0,${H} ${line} ${W},${H}`
  const up = data[data.length - 1] >= baseline
  const stroke = up ? "hsl(var(--positive))" : "hsl(var(--negative))"
  const baseY = y(baseline)
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-32 w-full rounded border border-border bg-panel"
      aria-label="Equity curve replay"
    >
      {/* baseline (starting balance) */}
      <line x1={0} y1={baseY} x2={W} y2={baseY} stroke="hsl(var(--border))" strokeWidth={0.4} strokeDasharray="2 2" />
      <polygon points={area} fill={stroke} fillOpacity={0.12} />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={0.8} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
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
