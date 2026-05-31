"use client"

import { useState } from "react"
import { Area, AreaChart, CartesianGrid, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import type { Performance } from "@/lib/types"
import { Panel } from "./ui-kit"
import { compact, num, pct, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

const RANGES = [
  { key: "1W", n: 7 },
  { key: "1M", n: 30 },
  { key: "3M", n: 90 },
] as const

export function PerformancePanel({ performance }: { performance: Performance }) {
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("3M")
  const n = RANGES.find((r) => r.key === range)!.n
  const data = performance.curve.slice(-n)

  const stats = [
    { label: "Today", value: pct(performance.todayPct), v: performance.todayPct },
    { label: "Week", value: pct(performance.weekPct), v: performance.weekPct },
    { label: "Month", value: pct(performance.monthPct), v: performance.monthPct },
    { label: "All-Time", value: pct(performance.totalReturnPct), v: performance.totalReturnPct },
  ]

  return (
    <Panel
      title="Performance & Returns"
      right={
        <div className="flex items-center gap-1">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                "rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold transition-colors",
                range === r.key ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.key}
            </button>
          ))}
        </div>
      }
      bodyClassName="flex flex-col p-3"
    >
      <div className="grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-border bg-border">
        {stats.map((s) => (
          <div key={s.label} className="flex flex-col gap-0.5 bg-panel px-2.5 py-2">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{s.label}</span>
            <span className={cn("font-mono text-sm font-semibold tabular", s.v >= 0 ? "text-positive" : "text-negative")}>{s.value}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 h-44 w-full">
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
              width={42}
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
              formatter={(v: number, name: string) => [usd(v), name === "equity" ? "Strategy" : "Benchmark"]}
            />
            <Line type="monotone" dataKey="benchmark" stroke="hsl(var(--muted-foreground))" strokeWidth={1} strokeDasharray="3 3" dot={false} />
            <Area type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={1.8} fill="url(#eq)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 grid grid-cols-3 gap-3 border-t border-border pt-2 text-[10px]">
        <Mini label="Win Rate" value={performance.winRate.toFixed(1) + "%"} />
        <Mini label="Profit Factor" value={performance.profitFactor.toFixed(2)} />
        <Mini label="Trades" value={num(performance.trades, 0)} />
        <Mini label="Avg Win" value={usd(performance.avgWin)} tone="positive" />
        <Mini label="Avg Loss" value={usd(performance.avgLoss)} tone="negative" />
        <Mini label="Best / Worst" value={`${pct(performance.bestDay)} / ${pct(performance.worstDay)}`} />
      </div>
    </Panel>
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
