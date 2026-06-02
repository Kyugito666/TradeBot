"use client"

import { Activity, Play, RefreshCw, Square } from "lucide-react"
import type { Snapshot } from "@/lib/types"
import { StatusDot } from "./ui-kit"
import { cn } from "@/lib/utils"

export function CommandBar({
  snapshot,
  onStart,
  onStop,
  onRefresh,
}: {
  snapshot: Snapshot
  onStart: () => void
  onStop: () => void
  onRefresh: () => void
}) {
  const { mode, engineOnline, marketOnline, activeSymbol } = snapshot
  const running = mode === "RUNNING"

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-panel px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-primary/15 text-primary">
          <Activity className="h-4 w-4" strokeWidth={2.5} />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-bold tracking-tight text-foreground">TRADEBOT</span>
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Quant Terminal</span>
          </div>
          <span className="text-[10px] text-muted-foreground">Multi-Agent Consensus Engine</span>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden items-center gap-4 md:flex">
          <MetaItem label="Engine">
            <span className="flex items-center gap-1.5">
              <StatusDot tone={engineOnline ? "positive" : "negative"} pulse={engineOnline} />
              <span className={cn("font-mono font-semibold", engineOnline ? "text-positive" : "text-negative")}>
                {engineOnline ? "ONLINE" : "OFFLINE"}
              </span>
            </span>
          </MetaItem>
          <MetaItem label="Bot">
            <span
              className={cn(
                "font-mono font-semibold",
                running ? "text-positive" : "text-muted-foreground",
              )}
            >
              {running ? "RUNNING" : "STOPPED"}
            </span>
          </MetaItem>
          <MetaItem label="Active Pair">
            <span className="font-mono tabular text-foreground">{activeSymbol || "—"}</span>
          </MetaItem>
          <MetaItem label="Market Feed">
            <span className="flex items-center gap-1.5">
              <StatusDot tone={marketOnline ? "primary" : "warning"} pulse={marketOnline} />
              <span className={cn("font-mono", marketOnline ? "text-foreground" : "text-warning")}>
                {marketOnline ? "LIVE" : "…"}
              </span>
            </span>
          </MetaItem>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={onStart}
            disabled={!engineOnline || running}
            title={engineOnline ? "Start the trading engine" : "Engine offline"}
            className={cn(
              "flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              running
                ? "border-positive/40 bg-positive/15 text-positive"
                : "border-border bg-transparent text-muted-foreground hover:border-positive/40 hover:text-positive",
            )}
          >
            <Play className="h-3.5 w-3.5" /> Start
          </button>
          <button
            onClick={onStop}
            disabled={!engineOnline || !running}
            title={engineOnline ? "Stop the trading engine" : "Engine offline"}
            className={cn(
              "flex items-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40",
              !running
                ? "border-negative/40 bg-negative/10 text-negative"
                : "border-border bg-transparent text-muted-foreground hover:border-negative/40 hover:text-negative",
            )}
          >
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
          <button
            onClick={onRefresh}
            title="Refresh data"
            className="ml-1 flex items-center gap-1.5 rounded border border-border px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
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
