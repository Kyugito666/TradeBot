"use client"

import { useState } from "react"

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
  const [period, setPeriod] = useState<"1H" | "4H" | "12H" | "1D" | "3D" | "1W" | "1M" | "ALL">("ALL")
  const hasTrades = performance.trades > 0

  const now = Date.now()
  const cutoffMap = {
    "1H": now - 3600000,
    "4H": now - 14400000,
    "12H": now - 43200000,
    "1D": now - 86400000,
    "3D": now - 259200000,
    "1W": now - 604800000,
    "1M": now - 2592000000,
    "ALL": 0
  }
  const cutoff = cutoffMap[period]
  
  let data = performance.curve.filter(p => p.t >= cutoff)
  
  let startEq = data.length > 0 ? data[0].equity : 0
  if (data.length > 0 && performance.curve.length > 0 && data[0].t > cutoff && period !== "ALL") {
    const prevPoint = performance.curve.slice().reverse().find(p => p.t < cutoff)
    if (prevPoint) {
      startEq = prevPoint.equity
      data = [{ t: cutoff, equity: prevPoint.equity }, ...data]
    }
  }

  // Dynamically calculate stats based on the visible curve period!
  const endEq = data.length > 0 ? data[data.length - 1].equity : startEq
  const periodRealized = endEq - startEq
  const periodReturnPct = startEq > 0 ? (periodRealized / startEq) * 100 : 0
  
  let periodWins = 0
  let periodLosses = 0
  let periodGrossWin = 0
  let periodGrossLoss = 0

  for (let i = 1; i < data.length; i++) {
    const diff = data[i].equity - data[i-1].equity
    if (diff > 0) { periodWins++; periodGrossWin += diff }
    else if (diff < 0) { periodLosses++; periodGrossLoss += Math.abs(diff) }
  }
  const periodTrades = periodWins + periodLosses
  const periodWinRate = periodTrades > 0 ? (periodWins / periodTrades) * 100 : 0
  const periodPf = periodGrossLoss === 0 ? (periodGrossWin > 0 ? 99 : 0) : periodGrossWin / periodGrossLoss
  
  const displayRealized = period === "ALL" ? performance.realizedPnl : periodRealized
  const displayReturn = period === "ALL" ? performance.totalReturnPct : periodReturnPct
  const displayWinRate = period === "ALL" ? performance.winRate : periodWinRate
  const displayTrades = period === "ALL" ? performance.trades : periodTrades
  const displayPf = period === "ALL" ? performance.profitFactor : periodPf
  const displayWins = period === "ALL" ? performance.wins : periodWins
  const displayLosses = period === "ALL" ? performance.losses : periodLosses

  return (
    <Panel 
      title="Performance & Returns" 
      right={
        <div className="flex items-center gap-1 bg-muted/20 p-0.5 rounded border border-border/50">
          {(["1H", "4H", "1D", "1W", "1M", "ALL"] as const).map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={cn(
                "px-2 py-0.5 text-[9px] font-mono font-bold rounded-sm transition-all", 
                period === p ? "bg-panel text-foreground shadow-sm border border-border/40" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {p}
            </button>
          ))}
        </div>
      }
      bodyClassName="flex flex-col p-3 h-full flex-1"
      className="h-full"
    >
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-sm">
        <Stat label={period === "ALL" ? "Realized P&L" : `${period} P&L`} value={usd(displayRealized, 2)} v={displayRealized} />
        <Stat label={period === "ALL" ? "Total Return" : `${period} Return`} value={pct(displayReturn)} v={displayReturn} />
        <Stat label="Win Rate" value={hasTrades && displayTrades > 0 ? displayWinRate.toFixed(1) + "%" : "—"} v={1} neutral />
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
              <XAxis 
                dataKey="t" 
                tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }} 
                tickLine={false} 
                axisLine={false} 
                minTickGap={28} 
                tickFormatter={(t) => new Date(t).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })}
              />
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
                  background: "rgba(10, 10, 10, 0.8)",
                  border: "1px solid hsl(var(--border))",
                  backdropFilter: "blur(8px)",
                  borderRadius: 8,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
                }}
                labelStyle={{ color: "hsl(var(--muted-foreground))" }}
                formatter={(v: number) => [usd(v, 2), "Equity"]}
                labelFormatter={(t) => new Date(t).toLocaleString("en-US", { hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              />
              <Area type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#eq)" dot={false} activeDot={{ r: 4, strokeWidth: 0, fill: "hsl(var(--primary))" }} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="relative h-full w-full">
            <div className="absolute inset-0 opacity-10 blur-[1px] pointer-events-none grayscale">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={[{t:1, equity: 100}, {t:2, equity: 105}, {t:3, equity: 102}, {t:4, equity: 115}, {t:5, equity: 110}, {t:6, equity: 130}]} margin={{ top: 6, right: 6, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="eq-ghost" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="equity" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#eq-ghost)" dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <EmptyState
              icon={LineChart}
              title={engineOnline ? "Awaiting First Close" : "Engine offline"}
              hint={
                engineOnline
                  ? "Chart akan tergambar otomatis begitu ada posisi trading yang di-close (TP/SL)."
                  : "Performance is built from real trade history — start the engine to populate it."
              }
              className="h-full py-0 relative z-10"
            />
          </div>
        )}
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 border-t border-border/50 pt-3 sm:grid-cols-3">
        <Mini label="Trades" value={num(displayTrades, 0)} />
        <Mini label="Profit Factor" value={hasTrades && displayTrades > 0 ? displayPf.toFixed(2) : "—"} />
        <Mini label="Wins / Losses" value={`${displayWins} / ${displayLosses}`} />
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
  const toneText = tone === "negative" ? "text-negative" : tone === "positive" ? "text-positive" : "text-foreground"
  return (
    <div className="group flex flex-col gap-1 rounded-md border border-border/40 bg-panel/50 px-3 py-2 transition-colors hover:border-border hover:bg-muted/20">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground/70">{label}</span>
      <span className={cn("font-mono text-xs font-semibold tabular", toneText)}>{value}</span>
    </div>
  )
}
