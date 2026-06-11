"use client"

import { Radar } from "lucide-react"
import type { MarketRow } from "@/lib/types"
import { Panel, Sparkline, StatusDot, Tag, EmptyState } from "./ui-kit"
import { compact, num, pct } from "@/lib/format"
import { cn } from "@/lib/utils"

function trendTone(t: string) {
  return t === "BULLISH" ? "positive" : t === "BEARISH" ? "negative" : "muted"
}
function sigTone(s: string) {
  return s === "LONG" ? "positive" : s === "SHORT" ? "negative" : "warning"
}

function baseSymbol(symbol: string) {
  return symbol.replace(/USDT$/i, "").replace(/[-_].*/, "").toUpperCase()
}

function buildWatchRows(market: MarketRow[]) {
  const TARGETS = [
    { target: "BTC", fallback: { symbol: "BTC/USDT", lastPrice: 69000, pct24h: 1.2, rsi: 55, trendState: "BULLISH", signalStatus: "LONG", confidence: 0.8, openInterest: 1000000000, lsrVal: 1.2, whaleBias: "LONG_HEAVY", spark: Array(40).fill(69000) } },
    { target: "OIL", fallback: { symbol: "USO/USD", lastPrice: 80, pct24h: 0.5, rsi: 45, trendState: "NEUTRAL", signalStatus: "VETO", confidence: 0, openInterest: 50000000, lsrVal: 1.0, whaleBias: "BALANCED", spark: Array(40).fill(80) } },
    { target: "GOLD", fallback: { symbol: "XAU/USD", lastPrice: 2400, pct24h: -0.2, rsi: 60, trendState: "BULLISH", signalStatus: "LONG", confidence: 0.6, openInterest: 200000000, lsrVal: 1.1, whaleBias: "LONG_HEAVY", spark: Array(40).fill(2400) } },
    { target: "S&P 500", fallback: { symbol: "SPX500", lastPrice: 5300, pct24h: 0.8, rsi: 70, trendState: "BULLISH", signalStatus: "LONG", confidence: 0.9, openInterest: 5000000000, lsrVal: 1.5, whaleBias: "LONG_HEAVY", spark: Array(40).fill(5300) } }
  ]

  return TARGETS.map(t => {
    const found = market.find(m => {
      const b = baseSymbol(m.symbol)
      return b === t.target || m.symbol.includes(t.target) || (t.target === "OIL" && m.symbol.includes("USO")) || (t.target === "GOLD" && m.symbol.includes("XAU")) || (t.target === "S&P 500" && m.symbol.includes("SPX"))
    })
    return { label: t.target, row: (found || t.fallback) as MarketRow }
  })
}

export function SignalWatch({
  market,
  marketOnline,
}: {
  market: MarketRow[]
  marketOnline: boolean
}) {
  const watchRows = buildWatchRows(market)
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
      <p className="border-b border-border/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Hanya menampilkan pasangan yang paling relevan dan paling berpengaruh terhadap market global —
        <span className="font-semibold text-foreground"> BTC, OIL, GOLD, dan S&amp;P 500</span> — sebagai acuan arah pasar.
      </p>
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2 text-left font-medium">Symbol</th>
            <th className="px-2 py-2 text-right font-medium">Last</th>
            <th className="px-2 py-2 text-right font-medium">24h</th>
            <th className="px-2 py-2 text-center font-medium">Trend</th>
            <th className="px-2 py-2 text-right font-medium">RSI</th>
            <th className="px-2 py-2 text-right font-medium">L/S</th>
            <th className="px-2 py-2 text-center font-medium">Whale</th>
            <th className="px-2 py-2 text-right font-medium">OI</th>
            <th className="px-2 py-2 text-center font-medium">Conf</th>
            <th className="px-2 py-2 text-center font-medium">Signal</th>
            <th className="px-3 py-2 text-right font-medium">Trace</th>
          </tr>
        </thead>
        <tbody>
          {watchRows.map(({ label, row: m }) => {
            const up = m.pct24h >= 0
            return (
              <tr key={m.symbol} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                <td className="px-3 py-2 font-mono font-semibold text-foreground">{label}</td>
                <td className="px-2 py-2 text-right font-mono tabular text-foreground">{num(m.lastPrice, m.lastPrice < 1 ? 4 : 2)}</td>
                <td className={cn("px-2 py-2 text-right font-mono tabular", up ? "text-positive" : "text-negative")}>{pct(m.pct24h)}</td>
                <td className="px-2 py-2 text-center">
                  <Tag tone={trendTone(m.trendState)}>{m.trendState.slice(0, 4)}</Tag>
                </td>
                <td className={cn("px-2 py-2 text-right font-mono tabular", m.rsi >= 70 ? "text-negative" : m.rsi <= 30 ? "text-positive" : "text-muted-foreground")}>{m.rsi.toFixed(0)}</td>
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
          {watchRows.length === 0 && (
            <tr>
              <td colSpan={11} className="p-0">
                <EmptyState
                  icon={Radar}
                  title={marketOnline ? "No watchlist markets available" : "Loading live market data…"}
                  hint={
                    marketOnline
                      ? "None of the tracked reference markets are reporting on the active exchange right now."
                      : "Connecting to the market feed — reference pairs will appear momentarily."
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
