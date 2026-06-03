"use client"

import { Ban, CheckCircle2, Gavel, Loader2, Minus, TrendingDown, TrendingUp } from "lucide-react"
import type { PendingForecast, TeamConsensus } from "@/hooks/use-live-data"
import { Panel, Tag, Meter, LoadingState } from "./ui-kit"
import { num } from "@/lib/format"
import { cn } from "@/lib/utils"

// Vote-based consensus verdict for the agent team. The headline is a binary
// decision — VOTED (a tradeable verdict) or VETO (blocked) — with the full vote
// tally shown for transparency.
export function AgentConsensusPanel({
  consensus,
  symbol,
  pendingForecast,
  lastGrade,
  className,
}: {
  consensus: TeamConsensus | null | undefined
  symbol: string
  pendingForecast?: PendingForecast | null
  lastGrade?: { symbol: string; isWin: boolean; pnlR: number; ts: number } | null
  className?: string
}) {
  if (!consensus) {
    return (
      <Panel title="Final Decision" className={className}>
        <LoadingState label="Polling the agent team for a verdict…" />
      </Panel>
    )
  }

  const isVeto = consensus.decision === "VETO"
  const dir = consensus.signal // LONG | SHORT | WAIT
  const tradeable = !isVeto && (dir === "LONG" || dir === "SHORT")

  // Headline tone: VETO = negative, VOTED LONG = positive, VOTED SHORT = negative,
  // VOTED HOLD = warning.
  const tone = isVeto ? "negative" : dir === "LONG" ? "positive" : dir === "SHORT" ? "negative" : "warning"
  const DecisionIcon = isVeto ? Gavel : dir === "LONG" ? TrendingUp : dir === "SHORT" ? TrendingDown : Minus
  const directionLabel = isVeto ? "VETO" : dir === "LONG" ? "LONG" : dir === "SHORT" ? "SHORT" : "HOLD"

  const v = consensus.votes
  const totalDirectional = v.long + v.short || 1

  return (
    <Panel
      title="Final Decision"
      right={<Tag tone="primary">{symbol.replace("USDT", "")}</Tag>}
      className={className}
      bodyClassName="flex flex-col gap-3 p-3 scroll-thin overflow-auto"
    >
      {/* Headline decision */}
      <div
        className={cn(
          "rounded-lg border p-3",
          tone === "positive" && "border-positive/30 bg-positive/8",
          tone === "negative" && "border-negative/30 bg-negative/8",
          tone === "warning" && "border-warning/30 bg-warning/8",
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DecisionIcon
              className={cn(
                "h-5 w-5",
                tone === "positive" && "text-positive",
                tone === "negative" && "text-negative",
                tone === "warning" && "text-warning",
              )}
            />
            <div className="flex flex-col">
              <span
                className={cn(
                  "font-mono text-xl font-bold leading-none tracking-tight",
                  tone === "positive" && "text-positive",
                  tone === "negative" && "text-negative",
                  tone === "warning" && "text-warning",
                )}
              >
                {consensus.decision}
              </span>
              <span className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {isVeto ? "Trade blocked" : `Team voted ${directionLabel}`}
              </span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Conviction</div>
            <div className="font-mono text-lg font-semibold tabular text-foreground">
              {(consensus.confidence * 100).toFixed(1)}%
            </div>
          </div>
        </div>
        <div className="mt-2">
          <Meter value={consensus.confidence} tone={tone} />
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{consensus.reasoning}</p>
      </div>

      {/* Vote tally */}
      <div className="rounded-lg border border-border bg-panel p-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Vote Tally</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {v.long + v.short + v.hold + v.veto} agents
          </span>
        </div>
        {/* Long vs Short split bar */}
        <div className="flex h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-positive" style={{ width: `${(v.long / totalDirectional) * 100}%` }} />
          <div className="h-full bg-negative" style={{ width: `${(v.short / totalDirectional) * 100}%` }} />
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-center">
          <VoteCell label="Long" value={v.long} tone="positive" />
          <VoteCell label="Short" value={v.short} tone="negative" />
          <VoteCell label="Hold" value={v.hold} tone="muted" />
          <VoteCell label="Veto" value={v.veto} tone="warning" />
        </div>
      </div>

      {/* Trade targets (only meaningful on a tradeable verdict) */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Target label="Entry" value={tradeable ? consensus.entry : 0} tone="foreground" />
        <Target label="Take Profit" value={tradeable ? consensus.tp : 0} tone="positive" />
        <Target label="Stop Loss" value={tradeable ? consensus.sl : 0} tone="negative" />
      </div>

      {/* Live forecast the agents are grading against TP/SL */}
      {pendingForecast && (
        <div className="rounded-lg border border-primary/30 bg-primary/8 p-2.5">
          <div className="flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
              Grading live forecast
            </span>
          </div>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {pendingForecast.direction} {(pendingForecast.symbol || "").replace("USDT", "")} · entry {num(pendingForecast.entry || 0, 2)} · TP{" "}
            {num(pendingForecast.tp || 0, 2)} · SL {num(pendingForecast.sl || 0, 2)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Agents are watching price to TP/SL — the outcome will be fed back to update their weights automatically.
          </p>
        </div>
      )}

      {/* Last graded outcome that fed self-improvement */}
      {lastGrade && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border p-2.5",
            lastGrade.isWin ? "border-positive/30 bg-positive/8" : "border-negative/30 bg-negative/8",
          )}
        >
          {lastGrade.isWin ? (
            <CheckCircle2 className="h-4 w-4 text-positive" />
          ) : (
            <Ban className="h-4 w-4 text-negative" />
          )}
          <div className="text-[11px]">
            <span className={cn("font-semibold", lastGrade.isWin ? "text-positive" : "text-negative")}>
              Last forecast {lastGrade.isWin ? "hit TP" : "hit SL"}
            </span>
            <span className="text-muted-foreground">
              {" "}
              ({(lastGrade.pnlR || 0) >= 0 ? "+" : ""}
              {(lastGrade.pnlR || 0).toFixed(2)}R) — agents self-adjusted.
            </span>
          </div>
        </div>
      )}
    </Panel>
  )
}

function VoteCell({ label, value, tone }: { label: string; value: number; tone: "positive" | "negative" | "warning" | "muted" }) {
  const toneText =
    tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : tone === "warning" ? "text-warning" : "text-muted-foreground"
  return (
    <div className="flex flex-col gap-0.5">
      <span className={cn("font-mono text-lg font-bold leading-none", toneText)}>{value}</span>
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
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
