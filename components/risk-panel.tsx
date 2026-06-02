"use client"

import type { RiskMetrics } from "@/lib/types"
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
        <span className="text-[10px] text-muted-foreground">
          {engineOnline ? `${risk.openPositions} open` : "offline"}
        </span>
      }
      bodyClassName="flex flex-col gap-3 p-3"
    >
      {/* account */}
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Cell label="Equity" value={usd(risk.equity, 2)} />
        <Cell label="Balance" value={usd(risk.balance, 2)} />
        <Cell label="Day P&L" value={usd(risk.dailyPnl, 2)} tone={risk.dailyPnl >= 0 ? "positive" : "negative"} />
      </div>

      {/* margin utilization */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Margin Utilization</span>
          <span className={cn("font-mono", marginTone === "negative" ? "text-negative" : marginTone === "warning" ? "text-warning" : "text-positive")}>
            {marginPct.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              marginTone === "negative" ? "bg-negative" : marginTone === "warning" ? "bg-warning" : "bg-positive",
            )}
            style={{ width: `${marginPct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] tabular text-muted-foreground">
          <span>Used {usd(risk.marginUsed, 2)}</span>
          <span>Free {usd(risk.marginFree, 2)}</span>
        </div>
      </div>

      {/* exposure */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Net Exposure</span>
          <span className={cn("font-mono", netTone === "positive" ? "text-positive" : "text-negative")}>
            {risk.netExposure >= 0 ? "+" : ""}
            {usd(risk.netExposure, 2)}
          </span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-positive" style={{ width: `${longPct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] tabular text-muted-foreground">
          <span>Gross {usd(risk.grossExposure, 2)}</span>
          <span>{risk.openPositions} positions</span>
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
    <div className="flex flex-col gap-0.5 bg-panel px-2.5 py-2">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold tabular", toneText)}>{value}</span>
    </div>
  )
}
