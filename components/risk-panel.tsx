"use client"

import type { RiskMetrics } from "@/lib/types"
import { Panel, Tag } from "./ui-kit"
import { num, pct, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

export function RiskPanel({ risk }: { risk: RiskMetrics }) {
  const marginPct = risk.marginRatio * 100
  const marginTone = marginPct > 70 ? "negative" : marginPct > 45 ? "warning" : "positive"
  const lossUsed = Math.min(1, Math.abs(Math.min(0, risk.dailyPnl)) / Math.abs(risk.dailyLossLimit))
  const longExp = Math.max(0, risk.netExposure)
  const netTone = risk.netExposure >= 0 ? "positive" : "negative"

  return (
    <Panel title="Risk & Exposure" bodyClassName="flex flex-col gap-3 p-3">
      {/* margin utilization */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Margin Utilization</span>
          <span className={cn("font-mono", marginTone === "negative" ? "text-negative" : marginTone === "warning" ? "text-warning" : "text-positive")}>
            {marginPct.toFixed(1)}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn("h-full rounded-full transition-all duration-500", marginTone === "negative" ? "bg-negative" : marginTone === "warning" ? "bg-warning" : "bg-positive")} style={{ width: `${marginPct}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] tabular text-muted-foreground">
          <span>Used {usd(risk.marginUsed)}</span>
          <span>Free {usd(risk.marginFree)}</span>
        </div>
      </div>

      {/* daily loss limit */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Daily Loss Limit</span>
          <span className="font-mono text-foreground">{usd(risk.dailyLossLimit)}</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-negative transition-all duration-500" style={{ width: `${lossUsed * 100}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] tabular text-muted-foreground">
          <span>Today P&L</span>
          <span className={risk.dailyPnl >= 0 ? "text-positive" : "text-negative"}>{usd(risk.dailyPnl)}</span>
        </div>
      </div>

      {/* exposure bar */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
          <span>Net Exposure</span>
          <span className={cn("font-mono", netTone === "positive" ? "text-positive" : "text-negative")}>
            {risk.netExposure >= 0 ? "+" : ""}{usd(risk.netExposure)}
          </span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-positive" style={{ width: `${(longExp / risk.grossExposure) * 100}%` }} />
        </div>
        <div className="mt-1 flex justify-between text-[10px] tabular text-muted-foreground">
          <span>Gross {usd(risk.grossExposure)}</span>
          <span>{risk.openPositions} positions</span>
        </div>
      </div>

      {/* metric grid */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border">
        <Cell label="Sharpe" value={num(risk.sharpe, 2)} />
        <Cell label="Sortino" value={num(risk.sortino, 2)} />
        <Cell label="Cur. Drawdown" value={pct(risk.currentDrawdown)} tone="warning" />
        <Cell label="Max Drawdown" value={pct(risk.maxDrawdown)} tone="negative" />
        <Cell label="VaR 95% 1d" value={usd(risk.valueAtRisk)} tone="warning" />
        <Cell
          label="Kill Switch"
          value={<Tag tone={risk.killSwitchArmed ? "primary" : "negative"}>{risk.killSwitchArmed ? "ARMED" : "OFF"}</Tag>}
        />
      </div>
    </Panel>
  )
}

function Cell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "warning" | "negative" }) {
  const toneText = tone === "negative" ? "text-negative" : tone === "warning" ? "text-warning" : "text-foreground"
  return (
    <div className="flex flex-col gap-0.5 bg-panel px-2.5 py-2">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-sm font-semibold tabular", toneText)}>{value}</span>
    </div>
  )
}
