"use client"

import { Database, History, Play, Trash2 } from "lucide-react"
import { Panel, Tag } from "./ui-kit"
import { cn } from "@/lib/utils"
import { num, usd } from "@/lib/format"
import type { BacktestResult } from "@/lib/backtest"

export function BacktestPanel({
  backtests,
  isBacktesting,
  runBacktest,
  clearBacktests,
}: {
  backtests: BacktestResult[]
  isBacktesting: boolean
  runBacktest: () => Promise<BacktestResult>
  clearBacktests: () => void
}) {
  const latest = backtests[0]

  return (
    <Panel
      title="Backtest (Local / Manual)"
      right={
        <Tag tone="outline">
          <Database className="h-3 w-3" />
          {backtests.length} SAVED
        </Tag>
      }
    >
      <div className="space-y-3 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Runs a deterministic backtest from your current mode &amp; exchange settings. Results are stored
            <span className="font-semibold"> locally in this browser</span> — nothing is sent to a server and it never
            runs automatically. Configure everything in the <span className="font-semibold">Mode &amp; Settings</span>{" "}
            tab, then come back here to run it.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            {backtests.length > 0 && (
              <button
                onClick={clearBacktests}
                className="flex items-center gap-1 rounded border border-border px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-negative/50 hover:text-negative"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
            <button
              onClick={() => runBacktest()}
              disabled={isBacktesting}
              className={cn(
                "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors",
                isBacktesting
                  ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
                  : "border-primary/40 bg-primary/10 text-primary hover:bg-primary/20",
              )}
            >
              <Play className="h-3.5 w-3.5" />
              {isBacktesting ? "Running…" : "Run Backtest"}
            </button>
          </div>
        </div>

        {latest && (
          <div className="rounded-md border border-border bg-background p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold">
                {latest.cexLabel} · {latest.style} · {latest.dryRun ? "Dry-Run" : "Real"}
              </span>
              <Tag tone={latest.netPnlPct >= 0 ? "positive" : "negative"}>
                {latest.netPnlPct >= 0 ? "+" : ""}
                {latest.netPnlPct}%
              </Tag>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Final Balance" value={usd(latest.finalBalance)} />
              <Stat label="Win Rate" value={`${latest.winRate}%`} />
              <Stat label="Trades" value={num(latest.trades, 0)} />
              <Stat label="Profit Factor" value={String(latest.profitFactor)} />
              <Stat label="Max Drawdown" value={`${latest.maxDrawdownPct}%`} tone="negative" />
              <Stat label="Wins" value={num(latest.wins, 0)} tone="positive" />
              <Stat label="Losses" value={num(latest.losses, 0)} tone="negative" />
              <Stat label="Margin" value={`${latest.marginUsagePct}% ${latest.marginMode}`} />
            </div>
          </div>
        )}

        {backtests.length > 1 && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <History className="h-3 w-3" />
              History
            </div>
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {backtests.slice(1).map((bt) => (
                <div
                  key={bt.id}
                  className="flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5 text-[11px]"
                >
                  <span className="text-muted-foreground">{new Date(bt.ranAt).toLocaleString("en-US")}</span>
                  <span className="font-mono">
                    {bt.cexLabel} · {bt.style}
                  </span>
                  <span
                    className={cn(
                      "font-mono font-semibold",
                      bt.netPnlPct >= 0 ? "text-positive" : "text-negative",
                    )}
                  >
                    {bt.netPnlPct >= 0 ? "+" : ""}
                    {bt.netPnlPct}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!latest && (
          <p className="rounded border border-dashed border-border px-2.5 py-6 text-center text-[11px] text-muted-foreground">
            No backtests yet. Configure your settings in the Mode &amp; Settings tab and run one here.
          </p>
        )}
      </div>
    </Panel>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "positive" | "negative"
}) {
  return (
    <div className="rounded border border-border bg-panel px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          "font-mono text-sm font-bold",
          tone === "positive" && "text-positive",
          tone === "negative" && "text-negative",
        )}
      >
        {value}
      </div>
    </div>
  )
}
