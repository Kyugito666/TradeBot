"use client"

import type { Snapshot } from "@/lib/types"
import { usd, pct } from "@/lib/format"
import { Sparkline } from "./ui-kit"
import { cn } from "@/lib/utils"

export function KpiStrip({ snapshot }: { snapshot: Snapshot }) {
  const { performance: p, risk, positions } = snapshot
  const upnl = positions.reduce((a, x) => a + x.unrealized, 0)

  const items = [
    { label: "Equity", value: usd(risk.equity), tone: "foreground" as const, spark: p.curve.slice(-30).map((c) => c.equity) },
    { label: "Today P&L", value: usd(risk.dailyPnl), tone: risk.dailyPnl >= 0 ? ("positive" as const) : ("negative" as const), sub: pct(p.todayPct) },
    { label: "Unrealized", value: usd(upnl), tone: upnl >= 0 ? ("positive" as const) : ("negative" as const) },
    { label: "Total Return", value: pct(p.totalReturnPct), tone: p.totalReturnPct >= 0 ? ("positive" as const) : ("negative" as const) },
    { label: "Sharpe", value: p ? snapshot.risk.sharpe.toFixed(2) : "-", tone: "foreground" as const, sub: `Sortino ${risk.sortino.toFixed(2)}` },
    { label: "Win Rate", value: p.winRate.toFixed(1) + "%", tone: "foreground" as const, sub: `PF ${p.profitFactor.toFixed(2)}` },
    { label: "Open Risk", value: usd(risk.valueAtRisk), tone: "warning" as const, sub: "VaR 95% 1d" },
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
            {it.spark && <Sparkline data={it.spark} tone="primary" width={56} height={20} />}
          </div>
        </div>
      ))}
    </div>
  )
}
