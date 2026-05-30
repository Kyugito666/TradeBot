"use client"

import { Ban, Check, Crown, Minus, TrendingDown, TrendingUp } from "lucide-react"
import type { Consensus } from "@/lib/types"
import { Panel, Tag, Meter } from "./ui-kit"
import { num } from "@/lib/format"
import { cn } from "@/lib/utils"

function voteVisual(vote: string) {
  switch (vote) {
    case "LONG":
      return { tone: "positive" as const, icon: TrendingUp }
    case "SHORT":
      return { tone: "negative" as const, icon: TrendingDown }
    case "VETO":
      return { tone: "negative" as const, icon: Ban }
    default:
      return { tone: "muted" as const, icon: Minus }
  }
}

export function ConsensusPanel({ consensus }: { consensus: Consensus }) {
  const { action, confidence, reason, vetoed, agents, entryTarget, tpTarget, slTarget, symbol } = consensus
  const actionTone = vetoed ? "negative" : action === "LONG" ? "positive" : action === "SHORT" ? "negative" : "warning"
  const ActionIcon = action === "LONG" ? TrendingUp : action === "SHORT" ? TrendingDown : vetoed ? Ban : Minus

  return (
    <Panel
      title="Consensus Engine"
      right={<Tag tone="primary">{symbol}</Tag>}
      className="row-span-2"
      bodyClassName="flex flex-col gap-3 p-3 scroll-thin overflow-auto"
    >
      {/* verdict */}
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
              {vetoed ? "VETOED" : action}
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

      {/* targets */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Target label="Entry" value={entryTarget} tone="foreground" />
        <Target label="Take Profit" value={tpTarget} tone="positive" />
        <Target label="Stop Loss" value={slTarget} tone="negative" />
      </div>

      {/* committee */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Specialist Committee</span>
          <span className="text-[10px] text-muted-foreground">{agents.length} agents</span>
        </div>
        {agents.map((a) => {
          const v = voteVisual(a.vote)
          const VIcon = v.icon
          return (
            <div key={a.id} className="rounded border border-border bg-card px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-xs font-semibold text-foreground">{a.name}</span>
                  {a.canVeto && <Crown className="h-3 w-3 text-warning" aria-label="Veto power" />}
                </div>
                <Tag tone={v.tone}>
                  <VIcon className="h-3 w-3" />
                  {a.vote}
                </Tag>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                <span className="truncate">{a.note}</span>
                <span className="shrink-0 font-mono tabular">w{num(a.weight, 2)}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <Meter value={a.confidence} tone={v.tone === "muted" ? "primary" : v.tone} />
                <span className="w-9 shrink-0 text-right font-mono text-[10px] tabular text-muted-foreground">
                  {(a.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </Panel>
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
      <span className={cn("font-mono text-sm font-semibold tabular", toneText[tone])}>{num(value, 2)}</span>
    </div>
  )
}
