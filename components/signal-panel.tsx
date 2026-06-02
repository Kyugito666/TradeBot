"use client"

import {
  Crosshair,
  Layers,
  Play,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react"
import { Panel, Stat, StatusDot, Tag } from "./ui-kit"
import { cn } from "@/lib/utils"
import { num, pct } from "@/lib/format"
import type { MarketRow } from "@/lib/types"
import type { AgentAnalysisResponse, TradingSettings } from "@/hooks/use-live-data"
import type { PairStat } from "@/lib/backtest"
import { useSignalTrades } from "@/hooks/use-signal-trades"
import { styleConfidenceGate, type PaperTrade } from "@/lib/signal-engine"

function priceFmt(n: number) {
  return num(n, n < 1 ? 5 : 2)
}

// Unrealized ROE for an open paper trade at the current mark.
function liveRoe(trade: PaperTrade, mark: number | undefined): number {
  if (mark === undefined || trade.entry <= 0) return 0
  const dir = trade.side === "LONG" ? 1 : -1
  return ((mark - trade.entry) / trade.entry) * dir * trade.leverage * 100
}

export function SignalPanel({
  market,
  marketOnline,
  tradingSettings,
  agentAnalysis,
  pairStats = {},
}: {
  market: MarketRow[]
  marketOnline: boolean
  tradingSettings: TradingSettings
  agentAnalysis?: AgentAnalysisResponse | null
  /** Per-pair backtest stats shared from the Backtest tab (same pairs/strategy). */
  pairStats?: Record<string, PairStat>
}) {
  const activeCex = tradingSettings.cexes.find((c) => c.id === tradingSettings.activeCex)
  const risk = tradingSettings.riskModel
  const style = tradingSettings.tradingStyle

  const {
    candidates,
    open,
    history,
    autoEntry,
    autoTpSl,
    stats,
    toggleAutoEntry,
    toggleAutoTpSl,
    openTrade,
    closeTrade,
    clearHistory,
  } = useSignalTrades({
    market,
    marketOnline,
    style,
    risk,
    activeCex,
    agentAnalysis,
  })

  const markBySymbol = new Map(market.map((m) => [m.symbol, m.lastPrice]))
  const openSymbols = new Set(open.map((t) => t.symbol))

  return (
    <div className="flex flex-col gap-3">
      {/* ── Config strip: mirrors the Settings tab (read-only) ── */}
      <Panel
        title="Signal Forward-Test"
        right={
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <StatusDot tone={marketOnline ? "primary" : "warning"} pulse={marketOnline} />
            {marketOnline ? "live scan running" : "connecting…"}
          </div>
        }
      >
        <div className="flex flex-col gap-3 p-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Paper-only forward test. Signals are scanned live across every real pair of the active exchange and follow
            your <span className="text-foreground">Mode &amp; Settings</span> configuration. The{" "}
            <span className="text-foreground">BT Edge</span> column reuses the same per-pair backtest data shown in the
            Backtest &amp; Consensus tabs, so all three views analyse one shared dataset. No real account or order
            execution is involved.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Tag tone="outline">
              <Layers className="h-3 w-3" /> {activeCex?.label ?? "—"}
            </Tag>
            <Tag tone="outline">MODE {activeCex?.marginMode?.toUpperCase() ?? "—"}</Tag>
            <Tag tone="outline">STYLE {style.toUpperCase()}</Tag>
            <Tag tone="outline">LEV {activeCex?.defaultLeverage ?? "—"}×</Tag>
            <Tag tone="primary">RISK {risk.preset.toUpperCase()}</Tag>
            <Tag tone="muted">RR 1:{risk.riskReward}</Tag>
            <Tag tone="muted">GATE ≥{(styleConfidenceGate(style) * 100).toFixed(0)}%</Tag>
          </div>

          {/* Auto controls */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={toggleAutoEntry}
              className={cn(
                "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors",
                autoEntry
                  ? "border-positive/40 bg-positive/15 text-positive"
                  : "border-border text-muted-foreground hover:border-primary/50",
              )}
            >
              {autoEntry ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
              Auto Entry {autoEntry ? "ON" : "OFF"}
            </button>
            <button
              onClick={toggleAutoTpSl}
              className={cn(
                "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors",
                autoTpSl
                  ? "border-primary/40 bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/50",
              )}
            >
              {autoTpSl ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
              Auto TP / SL {autoTpSl ? "ON" : "OFF"}
            </button>
            <div className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-positive" />
              Closed trades feed agent self-improvement
            </div>
          </div>
        </div>
      </Panel>

      {/* ── Forward-test performance (Signal-only paper history stats) ── */}
      <Panel title="Paper Performance (Signal Forward-Test)">
        <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Trades" value={stats.total} />
          <Stat label="Win Rate" value={`${stats.winRate}%`} tone={stats.winRate >= 50 ? "positive" : "warning"} />
          <Stat label="Wins / Losses" value={`${stats.wins} / ${stats.losses}`} />
          <Stat
            label="Net R"
            value={`${stats.netR >= 0 ? "+" : ""}${stats.netR}R`}
            tone={stats.netR >= 0 ? "positive" : "negative"}
          />
          <Stat
            label="Net ROI"
            value={pct(stats.netRoiPct)}
            tone={stats.netRoiPct >= 0 ? "positive" : "negative"}
          />
          <Stat label="Avg R" value={`${stats.avgR >= 0 ? "+" : ""}${stats.avgR}R`} />
        </div>
      </Panel>

      {/* ── Filtered live signals with Entry / TP / SL ── */}
      <Panel
        title="Filtered Signals"
        right={<Tag tone={candidates.length ? "primary" : "muted"}>{candidates.length} qualifying</Tag>}
        bodyClassName="overflow-auto scroll-thin"
      >
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Symbol</th>
              <th className="px-2 py-2 text-center font-medium">Side</th>
              <th className="px-2 py-2 text-right font-medium">Entry</th>
              <th className="px-2 py-2 text-right font-medium">TP</th>
              <th className="px-2 py-2 text-right font-medium">SL</th>
              <th className="px-2 py-2 text-right font-medium">Lev</th>
              <th className="px-2 py-2 text-right font-medium">Exp. ROI</th>
              <th className="px-2 py-2 text-center font-medium">BT Edge</th>
              <th className="px-2 py-2 text-center font-medium">Conf</th>
              <th className="px-3 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map(({ row, levels }) => {
              const isLong = levels.side === "LONG"
              const alreadyOpen = openSymbols.has(row.symbol)
              return (
                <tr key={row.symbol} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono font-semibold text-foreground">
                    {row.symbol.replace("USDT", "")}
                    <span className="text-muted-foreground">/USDT</span>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Tag tone={isLong ? "positive" : "negative"}>
                      {isLong ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {levels.side}
                    </Tag>
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular text-foreground">{priceFmt(levels.entry)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular text-positive">{priceFmt(levels.tp)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular text-negative">{priceFmt(levels.sl)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">{levels.leverage}×</td>
                  <td className="px-2 py-2 text-right font-mono tabular text-primary">+{levels.expectedRoiPct}%</td>
                  <td className="px-2 py-2 text-center font-mono tabular">
                    {(() => {
                      const stat = pairStats[row.symbol]
                      if (!stat) return <span className="text-muted-foreground">—</span>
                      return (
                        <span
                          className={cn(stat.expectancyR >= 0 ? "text-positive" : "text-negative")}
                          title={`Backtest: ${stat.trades} trades · ${stat.winRate}% win · ${stat.expectancyR >= 0 ? "+" : ""}${stat.expectancyR}R exp`}
                        >
                          {stat.winRate}% · {stat.expectancyR >= 0 ? "+" : ""}
                          {stat.expectancyR}R
                        </span>
                      )
                    })()}
                  </td>
                  <td className="px-2 py-2 text-center font-mono tabular text-muted-foreground">
                    {(row.confidence * 100).toFixed(0)}%
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => openTrade({ row, levels })}
                      disabled={alreadyOpen}
                      className={cn(
                        "inline-flex items-center gap-1 rounded border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors",
                        alreadyOpen
                          ? "cursor-not-allowed border-border text-muted-foreground opacity-60"
                          : "border-primary/40 text-primary hover:bg-primary/15",
                      )}
                    >
                      <Play className="h-3 w-3" />
                      {alreadyOpen ? "Open" : "Paper"}
                    </button>
                  </td>
                </tr>
              )
            })}
            {candidates.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {marketOnline
                    ? "No pairs currently pass the signal filter. Waiting for qualifying setups…"
                    : "Loading live market data…"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      {/* ── Open paper positions ── */}
      <Panel
        title="Open Paper Positions"
        right={<Tag tone={open.length ? "primary" : "muted"}>{open.length} open</Tag>}
        bodyClassName="overflow-auto scroll-thin"
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
              <th className="px-2 py-2 text-right font-medium">uROE</th>
              <th className="px-3 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {open.map((t) => {
              const mark = markBySymbol.get(t.symbol)
              const roe = liveRoe(t, mark)
              return (
                <tr key={t.id} className="border-t border-border/60 transition-colors hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono font-semibold text-foreground">
                    {t.symbol.replace("USDT", "")}
                    <span className="text-muted-foreground">/USDT</span>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Tag tone={t.side === "LONG" ? "positive" : "negative"}>{t.side}</Tag>
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular text-foreground">{priceFmt(t.entry)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">
                    {mark !== undefined ? priceFmt(mark) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular text-positive">{priceFmt(t.tp)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular text-negative">{priceFmt(t.sl)}</td>
                  <td
                    className={cn(
                      "px-2 py-2 text-right font-mono tabular",
                      roe >= 0 ? "text-positive" : "text-negative",
                    )}
                  >
                    {pct(roe)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => closeTrade(t.id)}
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:border-negative/40 hover:text-negative"
                    >
                      <Crosshair className="h-3 w-3" />
                      Close
                    </button>
                  </td>
                </tr>
              )
            })}
            {open.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No open paper positions. Enable{" "}
                  <span className="font-semibold text-foreground">Auto Entry</span> or open one manually from the
                  signals above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>

      {/* ── Paper trade history ── */}
      <Panel
        title="Paper Trade History"
        right={
          history.length > 0 ? (
            <button
              onClick={clearHistory}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:border-negative/40 hover:text-negative"
            >
              <Trash2 className="h-3 w-3" />
              Clear
            </button>
          ) : null
        }
        bodyClassName="overflow-auto scroll-thin"
      >
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Symbol</th>
              <th className="px-2 py-2 text-center font-medium">Side</th>
              <th className="px-2 py-2 text-right font-medium">Entry</th>
              <th className="px-2 py-2 text-right font-medium">Exit</th>
              <th className="px-2 py-2 text-center font-medium">Result</th>
              <th className="px-2 py-2 text-right font-medium">R</th>
              <th className="px-3 py-2 text-right font-medium">ROE</th>
            </tr>
          </thead>
          <tbody>
            {history.map((t) => {
              const win = (t.pnlR ?? 0) > 0
              return (
                <tr key={t.id} className="border-t border-border/60">
                  <td className="px-3 py-2 font-mono font-semibold text-foreground">
                    {t.symbol.replace("USDT", "")}
                    <span className="text-muted-foreground">/USDT</span>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Tag tone={t.side === "LONG" ? "positive" : "negative"}>{t.side}</Tag>
                  </td>
                  <td className="px-2 py-2 text-right font-mono tabular text-muted-foreground">{priceFmt(t.entry)}</td>
                  <td className="px-2 py-2 text-right font-mono tabular text-foreground">
                    {t.exitPrice !== undefined ? priceFmt(t.exitPrice) : "—"}
                  </td>
                  <td className="px-2 py-2 text-center">
                    <Tag tone={t.outcome === "TP" ? "positive" : t.outcome === "SL" ? "negative" : "muted"}>
                      {t.outcome ?? "—"}
                    </Tag>
                  </td>
                  <td
                    className={cn("px-2 py-2 text-right font-mono tabular", win ? "text-positive" : "text-negative")}
                  >
                    {(t.pnlR ?? 0) >= 0 ? "+" : ""}
                    {t.pnlR ?? 0}R
                  </td>
                  <td
                    className={cn(
                      "px-3 py-2 text-right font-mono tabular",
                      (t.pnlPct ?? 0) >= 0 ? "text-positive" : "text-negative",
                    )}
                  >
                    {pct(t.pnlPct ?? 0)}
                  </td>
                </tr>
              )
            })}
            {history.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-xs text-muted-foreground">
                  No closed paper trades yet. Results appear here as signals hit TP or SL.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
    </div>
  )
}
