"use client"

import type { RiskMetrics } from "@/lib/types"
import { PieChart, Pie, Cell as RechartsCell, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts"
import { Panel } from "./ui-kit"
import { usd } from "@/lib/format"
import { cn } from "@/lib/utils"

export function RiskPanel({ risk, engineOnline }: { risk: RiskMetrics; engineOnline: boolean }) {
  const marginPct = Math.min(100, risk.marginRatio * 100)
  const marginTone = marginPct > 70 ? "negative" : marginPct > 45 ? "warning" : "positive"
  const netTone = risk.netExposure >= 0 ? "positive" : "negative"
  const grossBase = risk.grossExposure || 1
  const longPct = Math.min(100, (Math.max(0, risk.netExposure) / grossBase) * 100)

  return (
    <Panel
      title="Risk & Exposure"
      right={
        <div className="flex items-center gap-2">
          {engineOnline && (
            <span className={cn("rounded-sm px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-background", marginTone === "negative" ? "bg-negative shadow-[0_0_10px_hsl(var(--negative))]" : marginTone === "warning" ? "bg-warning" : "bg-positive")}>
              {marginTone === "negative" ? "CRITICAL" : marginTone === "warning" ? "AGGRESSIVE" : "SAFE"}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground">
            {engineOnline ? `${risk.openPositions} open` : "offline"}
          </span>
        </div>
      }
      className="h-full"
      bodyClassName="flex flex-col gap-3 p-3 flex-1"
    >
      {/* account */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-sm">
        <Cell label="Equity" value={usd(risk.equity, 2)} />
        <Cell label="Balance" value={usd(risk.balance, 2)} />
        <Cell label="Day P&L" value={usd(risk.dailyPnl, 2)} tone={risk.dailyPnl >= 0 ? "positive" : "negative"} />
      </div>

      <div className="grid grid-cols-2 gap-3 flex-1 mt-2 min-h-[176px]">
        {/* Margin Donut */}
        <div className="flex flex-col border border-border/40 rounded-lg bg-panel/50 p-2 relative group hover:border-border hover:bg-muted/20 transition-colors">
          <div className="absolute top-2 left-2 text-[10px] uppercase tracking-wider text-muted-foreground z-10 group-hover:text-foreground/70 transition-colors">Margin</div>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={[
                  { name: 'Used', value: risk.marginUsed || 0.1, color: marginTone === "negative" ? "hsl(var(--negative))" : marginTone === "warning" ? "hsl(var(--warning))" : "hsl(var(--positive))" },
                  { name: 'Free', value: Math.max(0, risk.marginFree) || 0.1, color: "hsl(var(--muted))" },
                ]}
                cx="50%" cy="50%" innerRadius="65%" outerRadius="85%" paddingAngle={2} dataKey="value" stroke="none"
              >
                {[0, 1].map((_, index) => <RechartsCell key={`cell-${index}`} fill={index === 0 ? (marginTone === "negative" ? "hsl(var(--negative))" : marginTone === "warning" ? "hsl(var(--warning))" : "hsl(var(--positive))") : "hsl(var(--muted))"} />)}
              </Pie>
              <RechartsTooltip formatter={(val: number) => usd(val, 2)} contentStyle={{ background: "rgba(10,10,10,0.9)", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 10, fontFamily: "var(--font-mono)", color: "white" }} itemStyle={{ color: "white" }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-2">
            <span className={cn("font-mono font-bold text-lg", marginTone === "negative" ? "text-negative" : marginTone === "warning" ? "text-warning" : "text-positive")}>{marginPct.toFixed(1)}%</span>
            <span className="text-[9px] text-muted-foreground tabular">Used {usd(risk.marginUsed, 0)}</span>
          </div>
        </div>

        {/* Exposure Donut */}
        <div className="flex flex-col border border-border/40 rounded-lg bg-panel/50 p-2 relative group hover:border-border hover:bg-muted/20 transition-colors">
          <div className="absolute top-2 left-2 text-[10px] uppercase tracking-wider text-muted-foreground z-10 group-hover:text-foreground/70 transition-colors">Exposure</div>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={[
                  { name: 'Long', value: Math.max(0.1, risk.netExposure >= 0 ? risk.netExposure : 0), color: "hsl(var(--positive))" },
                  { name: 'Short', value: Math.max(0.1, risk.netExposure < 0 ? Math.abs(risk.netExposure) : 0), color: "hsl(var(--negative))" },
                ]}
                cx="50%" cy="50%" innerRadius="65%" outerRadius="85%" paddingAngle={2} dataKey="value" stroke="none"
              >
                <RechartsCell fill="hsl(var(--positive))" />
                <RechartsCell fill="hsl(var(--negative))" />
              </Pie>
              <RechartsTooltip formatter={(val: number) => usd(val, 2)} contentStyle={{ background: "rgba(10,10,10,0.9)", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 10, fontFamily: "var(--font-mono)", color: "white" }} itemStyle={{ color: "white" }} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none mt-2">
            <span className={cn("font-mono font-bold text-lg", netTone === "positive" ? "text-positive" : "text-negative")}>{usd(Math.abs(risk.netExposure), 0)}</span>
            <span className="text-[9px] text-muted-foreground tabular">Gross {usd(risk.grossExposure, 0)}</span>
          </div>
        </div>
      </div>

      {!engineOnline && (
        <p className="rounded border border-border bg-muted/30 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
          Risk metrics are derived from live engine balance and open positions. Start your TradeBot engine to populate
          them.
        </p>
      )}
    </Panel>
  )
}

function Cell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "positive" | "negative" }) {
  const toneText = tone === "negative" ? "text-negative" : tone === "positive" ? "text-positive" : "text-foreground"
  return (
    <div className="group flex flex-col gap-0.5 bg-panel/80 px-2.5 py-2.5 transition-colors hover:bg-muted/10">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground transition-colors group-hover:text-foreground/70">{label}</span>
      <span className={cn("font-mono text-[15px] font-semibold tabular", toneText)}>{value}</span>
    </div>
  )
}
