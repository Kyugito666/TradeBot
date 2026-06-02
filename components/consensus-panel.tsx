"use client"

import { Ban, Minus, TrendingDown, TrendingUp, WifiOff } from "lucide-react"
import type { Consensus } from "@/lib/types"
import { Panel, Tag, Meter } from "./ui-kit"
import { num } from "@/lib/format"
import { cn } from "@/lib/utils"

export function ConsensusPanel({
  consensus,
  engineOnline,
  className,
}: {
  consensus: Consensus | null
  engineOnline: boolean
  className?: string
}) {
  if (!engineOnline || !consensus) {
    return (
      <Panel title="Consensus Engine" className={className} bodyClassName="flex flex-col items-center justify-center gap-2 p-6 text-center">
        <WifiOff className="h-6 w-6 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {engineOnline ? "Waiting for first consensus from the engine…" : "Engine offline — no live consensus available."}
        </p>
      </Panel>
    )
  }

  const { action, confidence, reason, trendState, whaleBias, entryTarget, tpTarget, slTarget, symbol, updatedAt } =
    consensus
  const actionTone = action === "LONG" ? "positive" : action === "SHORT" ? "negative" : "warning"
  const ActionIcon = action === "LONG" ? TrendingUp : action === "SHORT" ? TrendingDown : action === "WAIT" ? Minus : Ban

  return (
    <Panel
      title="Consensus Engine"
      right={<Tag tone="primary">{symbol}</Tag>}
      className={className}
      bodyClassName="flex flex-col gap-3 p-3 scroll-thin overflow-auto"
    >
      <div
        className={cn(
          "rounded-lg border p-3",
          actionTone === "positive" && "border-positive/30 bg-positive/8",
          actionTone === "negative" && "border-negative/30 bg-negative/8",
          actionTone === "warning" && "border-warning/30 bg-warning/8",
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ActionIcon
              className={cn(
                "h-5 w-5",
                actionTone === "positive" && "text-positive",
                actionTone === "negative" && "text-negative",
                actionTone === "warning" && "text-warning",
              )}
            />
            <span
              className={cn(
                "font-mono text-xl font-bold tracking-tight",
                actionTone === "positive" && "text-positive",
                actionTone === "negative" && "text-negative",
                actionTone === "warning" && "text-warning",
              )}
            >
              {action}
            </span>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Confidence</div>
            <div className="font-mono text-lg font-semibold tabular text-foreground">{(confidence * 100).toFixed(1)}%</div>
          </div>
        </div>
        <div className="mt-2">
          <Meter value={confidence} tone={actionTone === "warning" ? "warning" : actionTone} />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{reason}</p>
      </div>

      {/* live regime context */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Ctx label="Trend" value={trendState} tone={trendState === "BULLISH" ? "positive" : trendState === "BEARISH" ? "negative" : "muted"} />
        <Ctx
          label="Whale Bias"
          value={whaleBias === "LONG_HEAVY" ? "LONG" : whaleBias === "SHORT_HEAVY" ? "SHORT" : "BALANCED"}
          tone={whaleBias === "LONG_HEAVY" ? "positive" : whaleBias === "SHORT_HEAVY" ? "negative" : "muted"}
        />
      </div>

      {/* targets */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Target label="Entry" value={entryTarget} tone="foreground" />
        <Target label="Take Profit" value={tpTarget} tone="positive" />
        <Target label="Stop Loss" value={slTarget} tone="negative" />
      </div>

      {updatedAt && (
        <p className="text-right text-[10px] text-muted-foreground">Updated {updatedAt}</p>
      )}
    </Panel>
  )
}

function Ctx({ label, value, tone }: { label: string; value: string; tone: "positive" | "negative" | "muted" }) {
  const toneText = tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-muted-foreground"
  return (
    <div className="flex flex-col gap-0.5 bg-panel px-2.5 py-2">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold", toneText)}>{value}</span>
    </div>
  )
}

function Target({ label, value, tone }: { label: string; value: number; tone: "foreground" | "positive" | "negative" }) {
  const toneText: Record<string, string> = {
    foreground: "text-foreground",
    positive: "text-positive",
    negative: "text-negative",
  }
  return (
    <div className="flex flex-col gap-0.5 bg-panel px-2.5 py-2">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold tabular", toneText[tone])}>{value ? num(value, 2) : "—"}</span>
    </div>
  )
}
