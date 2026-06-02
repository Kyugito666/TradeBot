"use client"

import { useState } from "react"
import {
  AlertTriangle,
  DollarSign,
  KeyRound,
  Percent,
  Plus,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Zap,
} from "lucide-react"
import { Panel, Tag } from "./ui-kit"
import { cn } from "@/lib/utils"
import { num } from "@/lib/format"
import type {
  CexConfig,
  CexId,
  DryRunConfig,
  MarginMode,
  TradingSettings,
  TradingStyle,
} from "@/hooks/use-live-data"

const TRADING_STYLES: { id: TradingStyle; label: string; hint: string }[] = [
  { id: "scalp", label: "Scalp", hint: "Seconds–minutes, high frequency" },
  { id: "intraday", label: "Intraday", hint: "Minutes–hours, no overnight" },
  { id: "swing", label: "Swing", hint: "Days–weeks, trend following" },
]

const MARGIN_MODES: MarginMode[] = ["isolated", "cross"]

export function SettingsPanel({
  dryRunConfig,
  toggleDryRun,
  updateDryRunConfig,
  tradingSettings,
  updateTradingSettings,
  updateCexConfig,
}: {
  dryRunConfig: DryRunConfig
  toggleDryRun: (enabled?: boolean) => void
  updateDryRunConfig: (config: Partial<DryRunConfig>) => void
  tradingSettings: TradingSettings
  updateTradingSettings: (patch: Partial<TradingSettings>) => void
  updateCexConfig: (id: CexId, patch: Partial<CexConfig>) => void
}) {
  const activeCex =
    tradingSettings.cexes.find((c) => c.id === tradingSettings.activeCex) ?? tradingSettings.cexes[0]
  const isReal = !dryRunConfig.enabled

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {/* ---- Execution mode ---- */}
        <Panel
          title="Execution Mode"
          right={
            <Tag tone={isReal ? "negative" : "primary"}>{isReal ? "REAL TRADING" : "DRY-RUN"}</Tag>
          }
        >
          <div className="space-y-3 p-3">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Choose how the engine executes signals. <span className="font-semibold">Dry-Run</span> simulates fills
              against live prices; <span className="font-semibold">Real</span> sends orders to the selected exchange
              using your API credentials.
            </p>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => toggleDryRun(true)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors",
                  !isReal
                    ? "border-primary bg-primary/10"
                    : "border-border hover:border-primary/50",
                )}
              >
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <ShieldCheck className="h-4 w-4" />
                  Dry-Run
                </div>
                <span className="text-[10px] text-muted-foreground">Paper trading, no real orders</span>
              </button>
              <button
                onClick={() => toggleDryRun(false)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors",
                  isReal
                    ? "border-negative bg-negative/10"
                    : "border-border hover:border-negative/50",
                )}
              >
                <div className="flex items-center gap-1.5 text-sm font-semibold">
                  <Zap className="h-4 w-4" />
                  Real
                </div>
                <span className="text-[10px] text-muted-foreground">Live orders with real funds</span>
              </button>
            </div>

            {isReal && (
              <div className="flex items-start gap-2 rounded border border-negative/30 bg-negative/10 p-2 text-[11px] text-negative">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Real mode places live orders. Ensure your API keys, leverage and margin limits are correct before
                  starting the engine.
                </span>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {isReal ? "Account Balance (reference)" : "Initial Balance"}
              </label>
              <div className="flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-muted-foreground" />
                <input
                  type="number"
                  value={dryRunConfig.initialBalance}
                  onChange={(e) => updateDryRunConfig({ initialBalance: Number(e.target.value) })}
                  className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-sm"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Risk Per Trade ({(dryRunConfig.riskPerTrade * 100).toFixed(1)}%)
              </label>
              <div className="flex items-center gap-2">
                <Percent className="h-4 w-4 text-muted-foreground" />
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="10"
                  value={dryRunConfig.riskPerTrade * 100}
                  onChange={(e) => updateDryRunConfig({ riskPerTrade: Number(e.target.value) / 100 })}
                  className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-sm"
                />
              </div>
            </div>
          </div>
        </Panel>

        {/* ---- Exchange & style ---- */}
        <Panel title="Exchange & Trading Style">
          <div className="space-y-4 p-3">
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Active CEX</label>
              <div className="flex flex-wrap gap-2">
                {tradingSettings.cexes.map((cex) => (
                  <button
                    key={cex.id}
                    onClick={() => updateTradingSettings({ activeCex: cex.id })}
                    className={cn(
                      "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors",
                      tradingSettings.activeCex === cex.id
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary",
                    )}
                  >
                    {cex.label}
                    {cex.enabled && <span className="h-1.5 w-1.5 rounded-full bg-positive" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Trading Style</label>
              <div className="grid grid-cols-3 gap-2">
                {TRADING_STYLES.map((style) => (
                  <button
                    key={style.id}
                    onClick={() => updateTradingSettings({ tradingStyle: style.id })}
                    title={style.hint}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded border p-2 text-left transition-colors",
                      tradingSettings.tradingStyle === style.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50",
                    )}
                  >
                    <span className="text-xs font-semibold">{style.label}</span>
                    <span className="text-[9px] leading-tight text-muted-foreground">{style.hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Enabled Exchanges</label>
              <div className="space-y-1.5">
                {tradingSettings.cexes.map((cex) => (
                  <div
                    key={cex.id}
                    className="flex items-center justify-between rounded border border-border bg-background px-2.5 py-1.5"
                  >
                    <span className="text-xs font-semibold">{cex.label}</span>
                    <button
                      onClick={() => updateCexConfig(cex.id, { enabled: !cex.enabled })}
                      className={cn(
                        "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors",
                        cex.enabled ? "bg-positive/15 text-positive" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {cex.enabled ? <ToggleRight className="h-3.5 w-3.5" /> : <ToggleLeft className="h-3.5 w-3.5" />}
                      {cex.enabled ? "ON" : "OFF"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* ---- Per-CEX leverage & margin ---- */}
      {activeCex && (
        <CexDetailPanel cex={activeCex} onChange={(patch) => updateCexConfig(activeCex.id, patch)} />
      )}

      {/* ---- API key env vars ---- */}
      <ApiKeysPanel cexes={tradingSettings.cexes} />
    </div>
  )
}

function CexDetailPanel({
  cex,
  onChange,
}: {
  cex: CexConfig
  onChange: (patch: Partial<CexConfig>) => void
}) {
  const [newPair, setNewPair] = useState("")
  const [newLev, setNewLev] = useState(5)

  const addPair = () => {
    const pair = newPair.trim().toUpperCase()
    if (!pair) return
    const existing = cex.pairLeverage.filter((p) => p.pair !== pair)
    onChange({ pairLeverage: [...existing, { pair, leverage: newLev }] })
    setNewPair("")
    setNewLev(5)
  }

  return (
    <Panel
      title={`${cex.label} — Leverage & Margin`}
      right={<Tag tone="primary">{cex.marginMode.toUpperCase()}</Tag>}
    >
      <div className="grid grid-cols-1 gap-4 p-3 lg:grid-cols-2">
        {/* Margin controls */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Margin Mode</label>
            <div className="grid grid-cols-2 gap-2">
              {MARGIN_MODES.map((mode) => (
                <button
                  key={mode}
                  onClick={() => onChange({ marginMode: mode })}
                  className={cn(
                    "rounded border px-3 py-1.5 text-xs font-semibold capitalize transition-colors",
                    cex.marginMode === mode
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:border-primary/50",
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="flex items-center justify-between text-[10px] uppercase tracking-wider text-muted-foreground">
              <span>Margin Usage</span>
              <span className="font-mono text-primary">{cex.marginUsagePct}%</span>
            </label>
            <input
              type="range"
              min={1}
              max={100}
              step={1}
              value={cex.marginUsagePct}
              onChange={(e) => onChange({ marginUsagePct: Number(e.target.value) })}
              className="w-full accent-primary"
            />
            <p className="text-[10px] text-muted-foreground">
              Share of available balance committed as margin per position.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Default Leverage ({cex.defaultLeverage}x)
            </label>
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-muted-foreground" />
              <input
                type="number"
                min={1}
                max={125}
                value={cex.defaultLeverage}
                onChange={(e) => onChange({ defaultLeverage: Number(e.target.value) })}
                className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-sm"
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Applied to any pair without a specific override below.
            </p>
          </div>
        </div>

        {/* Per-pair leverage overrides */}
        <div className="space-y-2">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Per-Pair Leverage Overrides
          </label>

          <div className="space-y-1.5">
            {cex.pairLeverage.length === 0 && (
              <p className="rounded border border-dashed border-border px-2.5 py-3 text-center text-[11px] text-muted-foreground">
                No overrides. All pairs use {cex.defaultLeverage}x.
              </p>
            )}
            {cex.pairLeverage.map((p) => (
              <div
                key={p.pair}
                className="flex items-center gap-2 rounded border border-border bg-background px-2.5 py-1.5"
              >
                <span className="flex-1 font-mono text-xs font-semibold">{p.pair}</span>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    max={125}
                    value={p.leverage}
                    onChange={(e) =>
                      onChange({
                        pairLeverage: cex.pairLeverage.map((x) =>
                          x.pair === p.pair ? { ...x, leverage: Number(e.target.value) } : x,
                        ),
                      })
                    }
                    className="w-16 rounded border border-border bg-panel px-2 py-1 text-right font-mono text-xs"
                  />
                  <span className="text-[10px] text-muted-foreground">x</span>
                </div>
                <button
                  onClick={() => onChange({ pairLeverage: cex.pairLeverage.filter((x) => x.pair !== p.pair) })}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-negative/10 hover:text-negative"
                  aria-label={`Remove ${p.pair} override`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              value={newPair}
              onChange={(e) => setNewPair(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPair()}
              placeholder="e.g. SOLUSDT"
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-xs uppercase placeholder:normal-case placeholder:text-muted-foreground"
            />
            <input
              type="number"
              min={1}
              max={125}
              value={newLev}
              onChange={(e) => setNewLev(Number(e.target.value))}
              className="w-16 rounded border border-border bg-background px-2 py-1.5 text-right font-mono text-xs"
            />
            <button
              onClick={addPair}
              className="flex items-center gap-1 rounded border border-primary/40 bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        </div>
      </div>
    </Panel>
  )
}

function ApiKeysPanel({ cexes }: { cexes: CexConfig[] }) {
  return (
    <Panel
      title="API Key Environment Variables"
      right={
        <Tag tone="outline">
          <KeyRound className="h-3 w-3" />
          ENV
        </Tag>
      }
    >
      <div className="space-y-3 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Exchange credentials are read from <span className="font-semibold">server environment variables</span> — they
          are never stored in the browser. Add the keys for each exchange you enable in your Vercel project settings
          (Vars), or in a local <span className="font-mono">.env</span> file for the Go engine. The dashboard&apos;s
          engine URL is configured via <span className="font-mono">NEXT_PUBLIC_ENGINE_URL</span>.
        </p>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {cexes.map((cex) => {
            const vars = [cex.apiKeyEnv, cex.apiSecretEnv, ...(cex.passphraseEnv ? [cex.passphraseEnv] : [])]
            return (
              <div key={cex.id} className="rounded-md border border-border bg-background p-2.5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">{cex.label}</span>
                  <Tag tone={cex.enabled ? "positive" : "muted"}>{cex.enabled ? "ENABLED" : "OFF"}</Tag>
                </div>
                <ul className="space-y-1">
                  {vars.map((v) => (
                    <li
                      key={v}
                      className="flex items-center gap-1.5 rounded bg-panel px-2 py-1 font-mono text-[10px] text-foreground"
                    >
                      <KeyRound className="h-3 w-3 shrink-0 text-muted-foreground" />
                      {v}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>

        <div className="flex items-start gap-2 rounded border border-warning/30 bg-warning/10 p-2 text-[11px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Never paste secret keys into the UI or commit them to source control. Use restricted, IP-whitelisted keys
            and grant only the permissions the engine needs (read + trade, no withdrawals).
          </span>
        </div>
      </div>
    </Panel>
  )
}
