"use client"

import type { Snapshot } from "@/lib/types"
import { usd, pct } from "@/lib/format"
import { Sparkline } from "./ui-kit"
import { cn } from "@/lib/utils"

export function KpiStrip({ snapshot }: { snapshot: Snapshot }) {
  const { performance: p, risk, positions } = snapshot
  const upnl = positions.reduce((a, x) => a + x.pnlUsd, 0)
  const hasTrades = p.trades > 0

  const items = [
    {
      label: "Equity",
      value: usd(risk.equity, 2),
      tone: "foreground" as const,
      spark: p.curve.slice(-30).map((c) => c.equity),
    },
    { label: "Balance", value: usd(risk.balance, 2), tone: "foreground" as const },
    {
      label: "Unrealized",
      value: usd(upnl, 2),
      tone: upnl >= 0 ? ("positive" as const) : ("negative" as const),
    },
    {
      label: "Realized P&L",
      value: usd(p.realizedPnl, 2),
      tone: p.realizedPnl >= 0 ? ("positive" as const) : ("negative" as const),
    },
    {
      label: "Total Return",
      value: pct(p.totalReturnPct),
      tone: p.totalReturnPct >= 0 ? ("positive" as const) : ("negative" as const),
    },
    {
      label: "Win Rate",
      value: hasTrades ? p.winRate.toFixed(1) + "%" : "—",
      tone: "foreground" as const,
      sub: `PF ${hasTrades ? p.profitFactor.toFixed(2) : "—"}`,
    },
    { label: "Open Positions", value: String(risk.openPositions), tone: "foreground" as const, sub: `${p.trades} trades` },
  ]

  const toneText: Record<string, string> = {
    positive: "text-positive",
    negative: "text-negative",
    warning: "text-warning",
    foreground: "text-foreground",
  }

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-7">
      {items.map((it) => (
        <div key={it.label} className="flex flex-col justify-between gap-1.5 bg-panel px-3 py-2.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{it.label}</span>
          <div className="flex items-end justify-between gap-2">
            <div className="flex flex-col">
              <span className={cn("font-mono text-base font-semibold leading-none tabular", toneText[it.tone])}>{it.value}</span>
              {it.sub && <span className="mt-1 text-[10px] tabular text-muted-foreground">{it.sub}</span>}
            </div>
            {it.spark && it.spark.length > 1 && <Sparkline data={it.spark} tone="primary" width={56} height={20} />}
          </div>
        </div>
      ))}
    </div>
  )
}
