"use client"

import { History } from "lucide-react"
import type { PaperTrade } from "@/lib/signal-engine"
import { Panel, Tag, EmptyState } from "./ui-kit"
import { num, pct, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

export function TradeHistoryTable({
  history,
  fallbackMargin = 0,
}: {
  history: PaperTrade[]
  fallbackMargin?: number
}) {
  const sorted = [...history].sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))

  return (
    <Panel
      title="Trade History"
      right={
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-muted-foreground">
            {history.length} trades
          </span>
        </div>
      }
      bodyClassName="overflow-auto scroll-thin max-h-[500px]"
    >
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-2 py-2 text-center font-medium">Side</th>
            <th className="px-2 py-2 text-right font-medium">Entry</th>
            <th className="px-2 py-2 text-right font-medium">Exit</th>
            <th className="px-2 py-2 text-right font-medium">Margin</th>
            <th className="px-2 py-2 text-right font-medium">PnL</th>
            <th className="px-3 py-2 text-right font-medium">ROE</th>
            <th className="px-3 py-2 text-right font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const margin = Number(p.margin) || fallbackMargin
            const pnlPct = p.pnlPct || 0
            const pnlUsd = margin * (pnlPct / 100)
            const win = pnlPct >= 0 // Check ROE directly, because if margin is 0, pnlUsd is 0 and treats as win.
            
            const openDate = new Date(p.openedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" })
            const closeDate = p.closedAt ? new Date(p.closedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" }) : "--"

            return (
              <tr key={p.id} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                <td className="px-3 py-2">
                  <div className="flex flex-col leading-tight">
                    <span className="font-mono font-semibold text-foreground">{p.symbol.replace("USDT", "")}</span>
                    <span className="font-mono text-[9px] text-muted-foreground">{openDate} → {closeDate}</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-center">
                  <Tag tone={p.side === "LONG" ? "positive" : "negative"}>{p.side}</Tag>
                </td>
                <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">{num(p.entry, 2)}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-foreground">{p.exitPrice ? num(p.exitPrice, 2) : "—"}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">
                  {usd(margin, 2)} <span className="text-[9px] opacity-70 ml-1">x{p.leverage || 1}</span>
                </td>
                <td className={cn("px-2 py-2 text-right font-mono tabular font-semibold", win ? "text-positive" : "text-negative")}>{usd(pnlUsd, 2)}</td>
                <td className={cn("px-3 py-2 text-right font-mono tabular", win ? "text-positive" : "text-negative")}>{pct(pnlPct)}</td>
                <td className="px-3 py-2 text-right font-mono text-[10px] text-muted-foreground">{p.outcome || "MANUAL"}</td>
              </tr>
            )
          })}
          {sorted.length === 0 && (
            <tr>
              <td colSpan={8} className="p-0">
                <EmptyState
                  icon={History}
                  title={"No trade history"}
                  hint={"Closed positions will appear here."}
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  )
}
