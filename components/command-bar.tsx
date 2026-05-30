"use client"

import { Activity, Pause, Play, Power, ShieldAlert, ShieldCheck, Square } from "lucide-react"
import type { BotMode, Snapshot } from "@/lib/types"
import { StatusDot } from "./ui-kit"
import { uptime } from "@/lib/format"
import { cn } from "@/lib/utils"

export function CommandBar({
  snapshot,
  onMode,
  onToggleKill,
}: {
  snapshot: Snapshot
  onMode: (m: BotMode) => void
  onToggleKill: () => void
}) {
  const { mode, cycle, latencyMs, uptimeSec, risk } = snapshot
  const running = mode === "RUNNING"

  const modeTone = running ? "positive" : mode === "PAUSED" ? "warning" : "negative"
  const modeLabel = running ? "RUNNING" : mode === "PAUSED" ? "PAUSED" : "STOPPED"

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-panel px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-primary/15 text-primary">
          <Activity className="h-4 w-4" strokeWidth={2.5} />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold tracking-tight text-foreground">AXIOM</span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Quant Terminal</span>
          </div>
          <span className="text-[10px] text-muted-foreground">Multi-Agent Consensus Engine</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden items-center gap-4 md:flex">
          <MetaItem label="Mode">
            <span className="flex items-center gap-1.5">
              <StatusDot tone={modeTone} pulse={running} />
              <span className={cn("font-mono font-semibold", running ? "text-positive" : mode === "PAUSED" ? "text-warning" : "text-negative")}>
                {modeLabel}
              </span>
            </span>
          </MetaItem>
          <MetaItem label="Cycle">
            <span className="font-mono tabular text-foreground">{cycle.toLocaleString()}</span>
          </MetaItem>
          <MetaItem label="Latency">
            <span className={cn("font-mono tabular", latencyMs > 45 ? "text-warning" : "text-foreground")}>{latencyMs}ms</span>
          </MetaItem>
          <MetaItem label="Uptime">
            <span className="font-mono tabular text-foreground">{uptime(uptimeSec)}</span>
          </MetaItem>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onMode("RUNNING")}
            disabled={running}
            className={cn(
              "flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-semibold transition-colors",
              running
                ? "border-positive/40 bg-positive/15 text-positive"
                : "border-border bg-transparent text-muted-foreground hover:border-positive/40 hover:text-positive",
            )}
          >
            <Play className="h-3.5 w-3.5" /> Start
          </button>
          <button
            onClick={() => onMode("PAUSED")}
            disabled={mode === "PAUSED"}
            className={cn(
              "flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-semibold transition-colors",
              mode === "PAUSED"
                ? "border-warning/40 bg-warning/15 text-warning"
                : "border-border bg-transparent text-muted-foreground hover:border-warning/40 hover:text-warning",
            )}
          >
            <Pause className="h-3.5 w-3.5" /> Pause
          </button>
          <button
            onClick={() => onMode("STOPPED")}
            disabled={mode === "STOPPED"}
            className={cn(
              "flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-semibold transition-colors",
              mode === "STOPPED"
                ? "border-negative/40 bg-negative/15 text-negative"
                : "border-border bg-transparent text-muted-foreground hover:border-negative/40 hover:text-negative",
            )}
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
          <button
            onClick={onToggleKill}
            title="Kill switch closes all positions and halts execution"
            className={cn(
              "ml-1 flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-semibold transition-colors",
              risk.killSwitchArmed
                ? "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
                : "border-negative/50 bg-negative/15 text-negative",
            )}
          >
            {risk.killSwitchArmed ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldAlert className="h-3.5 w-3.5" />}
            {risk.killSwitchArmed ? "Armed" : "Disarmed"}
          </button>
        </div>
      </div>
    </header>
  )
}

function MetaItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col leading-tight">
      <span className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{label}</span>
      <span className="text-xs">{children}</span>
    </div>
  )
}
