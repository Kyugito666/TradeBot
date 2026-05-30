"use client"

import { X } from "lucide-react"
import type { Position } from "@/lib/types"
import { Panel, Tag } from "./ui-kit"
import { num, pct, usd } from "@/lib/format"
import { cn } from "@/lib/utils"

export function PositionsTable({ positions }: { positions: Position[] }) {
  const totalNotional = positions.reduce((a, p) => a + p.notional, 0)
  const totalUpnl = positions.reduce((a, p) => a + p.unrealized, 0)

  return (
    <Panel
      title="Open Positions"
      right={
        <div className="flex items-center gap-3 text-[10px]">
          <span className="text-muted-foreground">
            Notional <span className="font-mono text-foreground">{usd(totalNotional)}</span>
          </span>
          <span className="text-muted-foreground">
            uPnL{" "}
            <span className={cn("font-mono", totalUpnl >= 0 ? "text-positive" : "text-negative")}>{usd(totalUpnl)}</span>
          </span>
        </div>
      }
      bodyClassName="overflow-auto scroll-thin"
    >
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-2 py-2 text-center font-medium">Side</th>
            <th className="px-2 py-2 text-right font-medium">Size</th>
            <th className="px-2 py-2 text-right font-medium">Entry</th>
            <th className="px-2 py-2 text-right font-medium">Mark</th>
            <th className="px-2 py-2 text-right font-medium">Liq</th>
            <th className="px-2 py-2 text-right font-medium">uPnL</th>
            <th className="px-2 py-2 text-right font-medium">ROE</th>
            <th className="px-3 py-2 text-center font-medium">Close</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const win = p.unrealized >= 0
            return (
              <tr key={p.id} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                <td className="px-3 py-2">
                  <div className="flex flex-col leading-tight">
                    <span className="font-mono font-semibold text-foreground">{p.symbol.replace("USDT", "")}</span>
                    <span className="font-mono text-[9px] text-muted-foreground">{p.leverage}x · {p.openedAt}</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-center">
                  <Tag tone={p.side === "LONG" ? "positive" : "negative"}>{p.side}</Tag>
                </td>
                <td className="px-2 py-2 text-right font-mono tabular text-foreground">{num(p.size, 3)}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">{num(p.entry, 2)}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-foreground">{num(p.mark, 2)}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-warning">{num(p.liq, 2)}</td>
                <td className={cn("px-2 py-2 text-right font-mono tabular font-semibold", win ? "text-positive" : "text-negative")}>{usd(p.unrealized)}</td>
                <td className={cn("px-2 py-2 text-right font-mono tabular", win ? "text-positive" : "text-negative")}>{pct(p.unrealizedPct)}</td>
                <td className="px-3 py-2 text-center">
                  <button
                    className="inline-flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:border-negative/50 hover:text-negative"
                    aria-label={`Close ${p.symbol} position`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            )
          })}
          {positions.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-xs text-muted-foreground">
                No open positions — engine waiting for consensus.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  )
}
