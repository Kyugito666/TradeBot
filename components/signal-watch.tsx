"use client"

import type { MarketRow } from "@/lib/types"
import { Panel, Sparkline, StatusDot, Tag } from "./ui-kit"
import { compact, num, pct } from "@/lib/format"
import { cn } from "@/lib/utils"

function trendTone(t: string) {
  return t === "BULLISH" ? "positive" : t === "BEARISH" ? "negative" : "muted"
}
function sigTone(s: string) {
  return s === "LONG" ? "positive" : s === "SHORT" ? "negative" : "warning"
}

export function SignalWatch({
  market,
  marketOnline,
}: {
  market: MarketRow[]
  marketOnline: boolean
}) {
  return (
    <Panel
      title="Signal & Strategy Overview"
      right={
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <StatusDot tone={marketOnline ? "primary" : "warning"} pulse={marketOnline} />
          {marketOnline ? "live scan" : "connecting…"}
        </div>
      }
      bodyClassName="overflow-auto scroll-thin"
    >
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-2 py-2 text-right font-medium">Last</th>
            <th className="px-2 py-2 text-right font-medium">24h</th>
            <th className="px-2 py-2 text-center font-medium">Trend</th>
            <th className="px-2 py-2 text-right font-medium">L/S</th>
            <th className="px-2 py-2 text-center font-medium">Whale</th>
            <th className="px-2 py-2 text-right font-medium">OI</th>
            <th className="px-2 py-2 text-center font-medium">Conf</th>
            <th className="px-2 py-2 text-center font-medium">Signal</th>
            <th className="px-3 py-2 text-right font-medium">Trace</th>
          </tr>
        </thead>
        <tbody>
          {market.map((m) => {
            const up = m.pct24h >= 0
            return (
              <tr key={m.symbol} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                <td className="px-3 py-2 font-mono font-semibold text-foreground">{m.symbol.replace("USDT", "")}<span className="text-muted-foreground">/USDT</span></td>
                <td className="px-2 py-2 text-right font-mono tabular text-foreground">{num(m.lastPrice, m.lastPrice < 1 ? 4 : 2)}</td>
                <td className={cn("px-2 py-2 text-right font-mono tabular", up ? "text-positive" : "text-negative")}>{pct(m.pct24h)}</td>
                <td className="px-2 py-2 text-center">
                  <Tag tone={trendTone(m.trendState)}>{m.trendState.slice(0, 4)}</Tag>
                </td>
                <td className={cn("px-2 py-2 text-right font-mono tabular", m.lsrVal > 1 ? "text-positive" : "text-negative")}>{num(m.lsrVal, 2)}</td>
                <td className="px-2 py-2 text-center">
                  <span className={cn("font-mono text-[10px] font-semibold", m.whaleBias === "LONG_HEAVY" ? "text-positive" : m.whaleBias === "SHORT_HEAVY" ? "text-negative" : "text-muted-foreground")}>
                    {m.whaleBias === "LONG_HEAVY" ? "LONG" : m.whaleBias === "SHORT_HEAVY" ? "SHORT" : "BAL"}
                  </span>
                </td>
                <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">{compact(m.openInterest)}</td>
                <td className="px-2 py-2">
                  <div className="mx-auto flex w-16 items-center gap-1.5">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                      <div className={cn("h-full rounded-full", m.confidence > 0.6 ? "bg-positive" : m.confidence > 0.3 ? "bg-warning" : "bg-muted-foreground")} style={{ width: `${m.confidence * 100}%` }} />
                    </div>
                    <span className="w-6 text-right font-mono text-[10px] tabular text-muted-foreground">{(m.confidence * 100).toFixed(0)}</span>
                  </div>
                </td>
                <td className="px-2 py-2 text-center">
                  <Tag tone={sigTone(m.signalStatus)}>{m.signalStatus}</Tag>
                </td>
                <td className="px-3 py-2">
                  <div className="flex justify-end">
                    <Sparkline data={m.spark} tone={up ? "positive" : "negative"} width={76} height={22} />
                  </div>
                </td>
              </tr>
            )
          })}
          {market.length === 0 && (
            <tr>
              <td colSpan={10} className="px-3 py-8 text-center text-xs text-muted-foreground">
                {marketOnline ? "No market rows." : "Loading live market data…"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Panel>
  )
}
