"use client"

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { LineChart } from "lucide-react"
import type { Performance } from "@/lib/types"
import { Panel, EmptyState } from "./ui-kit"
import { compact, num, pct, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

export function PerformancePanel({
  performance,
  engineOnline,
}: {
  performance: Performance
  engineOnline: boolean
}) {
  const hasTrades = performance.trades > 0
  const data = performance.curve

  return (
    <Panel title="Performance & Returns" bodyClassName="flex flex-col p-3">
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Stat label="Realized P&L" value={usd(performance.realizedPnl, 2)} v={performance.realizedPnl} />
        <Stat label="Total Return" value={pct(performance.totalReturnPct)} v={performance.totalReturnPct} />
        <Stat label="Win Rate" value={hasTrades ? performance.winRate.toFixed(1) + "%" : "—"} v={1} neutral />
      </div>

      <div className="mt-3 h-44 w-full">
        {hasTrades ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="eq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--grid))" vertical={false} />
              <XAxis dataKey="t" tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} minTickGap={28} />
              <YAxis
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                tickLine={false}
                axisLine={false}
                width={48}
                domain={["auto", "auto"]}
                tickFormatter={(v) => compact(v)}
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                formatter={(v: number) => [usd(v, 2), "Equity"]}
              />
              <Area type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={1.8} fill="url(#eq)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState
            icon={LineChart}
            title={engineOnline ? "No closed trades yet" : "Engine offline"}
            hint={
              engineOnline
                ? "Your equity curve will plot here after the first position is closed."
                : "Performance is built from real trade history — start the engine to populate it."
            }
            className="h-full py-0"
          />
        )}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-3 border-t border-border pt-2 text-[10px]">
        <Mini label="Trades" value={num(performance.trades, 0)} />
        <Mini label="Profit Factor" value={hasTrades ? performance.profitFactor.toFixed(2) : "—"} />
        <Mini label="Wins / Losses" value={`${performance.wins} / ${performance.losses}`} />
        <Mini label="Avg Win" value={usd(performance.avgWin, 2)} tone="positive" />
        <Mini label="Avg Loss" value={usd(performance.avgLoss, 2)} tone="negative" />
        <Mini label="Best / Worst" value={`${usd(performance.bestTrade, 0)} / ${usd(performance.worstTrade, 0)}`} />
      </div>
    </Panel>
  )
}

function Stat({ label, value, v, neutral }: { label: string; value: string; v: number; neutral?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 bg-panel px-2.5 py-2">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold tabular", neutral ? "text-foreground" : v >= 0 ? "text-positive" : "text-negative")}>
        {value}
      </span>
    </div>
  )
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "positive" | "negative" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular font-semibold", tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-foreground")}>{value}</span>
    </div>
  )
}
