"use client"

import { Boxes } from "lucide-react"
import type { Position } from "@/lib/types"
import { Panel, Tag, EmptyState } from "./ui-kit"
import { num, pct, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

export function PositionsTable({
  positions,
  engineOnline,
  className,
}: {
  positions: Position[]
  engineOnline: boolean
  className?: string
}) {
  const priceFmt = (n: number) => num(n, n < 1 ? 5 : 2)

  const totalMargin = positions.reduce((a, p) => a + p.margin, 0)
  const totalUpnl = positions.reduce((a, p) => a + p.pnlUsd, 0)

  return (
    <Panel
      className={className}
      title="Open Positions"
      right={
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-muted-foreground">
            Margin <span className="font-mono text-foreground">{usd(totalMargin, 2)}</span>
          </span>
          <span className="text-muted-foreground">
            uPnL{" "}
            <span className={cn("font-mono", totalUpnl >= 0 ? "text-positive" : "text-negative")}>{usd(totalUpnl, 2)}</span>
          </span>
        </div>
      }
      bodyClassName="overflow-auto scroll-thin flex-1"
    >
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-2 py-2 text-center font-medium">Side</th>
            <th className="px-2 py-2 text-right font-medium">Entry</th>
            <th className="px-2 py-2 text-right font-medium">Mark</th>
            <th className="px-2 py-2 text-right font-medium">TP</th>
            <th className="px-2 py-2 text-right font-medium">SL</th>
            <th className="px-2 py-2 text-right font-medium">Margin</th>
            <th className="px-2 py-2 text-right font-medium">uPnL</th>
            <th className="px-3 py-2 text-right font-medium">ROE</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const isPending = p.status === "PENDING" || p.status === "pending"
            const win = !isPending && p.pnlUsd >= 0
            const displayPnl = isPending ? 0 : p.pnlUsd
            const displayRoe = isPending ? 0 : p.pnlPct
            const statusLabel = isPending ? "LIMIT" : "FILLED"
            const statusColor = isPending ? "text-amber-400" : "text-cyan-400"
            return (
              <tr key={p.id} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                <td className="px-3 py-2">
                  <div className="flex flex-col leading-tight">
                    <span className="font-mono font-semibold text-foreground">{p.symbol.replace("USDT", "")}</span>
                    <span className={cn("font-mono text-[9px]", statusColor)}>{statusLabel} · {p.openedAt}</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-center">
                  <Tag tone={p.side === "LONG" ? "positive" : "negative"}>{p.side}</Tag>
                </td>
                <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">{priceFmt(p.entry)}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-foreground">{priceFmt(p.mark)}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-positive">{p.tp ? priceFmt(p.tp) : "—"}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-negative">{p.sl ? priceFmt(p.sl) : "—"}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">
                  {usd(p.margin, 2)} <span className="text-[9px] opacity-70 ml-1">x{p.leverage || 1}</span>
                </td>
                <td className={cn("px-2 py-2 text-right font-mono tabular font-semibold", isPending ? "text-muted-foreground" : win ? "text-positive" : "text-negative")}>{isPending ? "—" : usd(displayPnl, 2)}</td>
                <td className={cn("px-3 py-2 text-right font-mono tabular", isPending ? "text-muted-foreground" : win ? "text-positive" : "text-negative")}>{isPending ? "—" : pct(displayRoe)}</td>
              </tr>
            )
          })}
          {positions.length === 0 && (
            <tr>
              <td colSpan={9} className="p-0">
                <EmptyState
                  icon={Boxes}
                  title={engineOnline ? "No open positions" : "Engine offline"}
                  hint={
                    engineOnline
                      ? "The engine is waiting for a consensus signal before opening a trade."
                      : "Start your local TradeBot engine to stream live positions here."
                  }
                />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  )
}
