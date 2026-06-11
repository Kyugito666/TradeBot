"use client"

import { useState, useEffect } from "react"
import {
  Activity,
  AlertTriangle,
  DollarSign,
  Gauge,
  KeyRound,
  Plus,
  Scale,
  ShieldCheck,
  Target,
  ToggleLeft,
  ToggleRight,
  Trash2,
  TrendingUp,
  Zap,
} from "lucide-react"
import { Panel, Tag } from "./ui-kit"
import { cn } from "@/lib/utils"
import { ENGINE_URL } from "@/lib/engine"
import {
  RISK_OPTIONS,
  RISK_PRESETS,
  type CexConfig,
  type CexId,
  type DryRunConfig,
  type MarginMode,
  type RiskModel,
  type RiskPreset,
  type TradingSettings,
  type TradingStyle,
} from "@/hooks/use-live-data"

const TRADING_STYLES: { id: TradingStyle; label: string; hint: string }[] = [
  { id: "scalp", label: "Scalp", hint: "Seconds–minutes, high frequency" },
  { id: "intraday", label: "Intraday", hint: "Minutes–hours, no overnight" },
  { id: "swing", label: "Swing", hint: "Days–weeks, trend following" },
  { id: "momentum_burst", label: "Momentum", hint: "High volatility volume spikes" },
  { id: "mean_reversion", label: "Mean Rev", hint: "Fading extremes (Auto-Adjusting)" },
  { id: "trend_following", label: "Trend", hint: "Riding the wave (Auto-Adjusting)" },
]

const MARGIN_MODES: MarginMode[] = ["isolated", "cross"]

const RISK_PRESET_META: { id: RiskPreset; label: string; hint: string }[] = [
  { id: "conservative", label: "Conservative", hint: "Tight risk, wide stops" },
  { id: "balanced", label: "Balanced", hint: "Even risk / reward" },
  { id: "aggressive", label: "Aggressive", hint: "Higher risk, faster targets" },
  { id: "custom_detailed", label: "Detailed", hint: "Manual fine-tuned risk" },
  { id: "custom_auto", label: "Auto-Pilot", hint: "Agent-managed adaptive risk" },
]

export function SettingsPanel({
  dryRunConfig,
  toggleDryRun,
  updateDryRunConfig,
  tradingSettings,
  updateTradingSettings,
  updateCexConfig,
  updateRiskModel,
  applyRiskPreset,
}: {
  dryRunConfig: DryRunConfig
  toggleDryRun: (enabled?: boolean) => void
  updateDryRunConfig: (config: Partial<DryRunConfig>) => void
  tradingSettings: TradingSettings
  updateTradingSettings: (patch: Partial<TradingSettings>) => void
  updateCexConfig: (id: CexId, patch: Partial<CexConfig>) => void
  updateRiskModel: (patch: Partial<RiskModel>) => void
  applyRiskPreset: (preset: RiskPreset) => void
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

            <p className="rounded border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
              Risk sizing is controlled from the{" "}
              <span className="font-semibold text-foreground">Risk Trade</span> panel below using a flexible,
              preset-based model — current risk per trade:{" "}
              <span className="font-mono font-semibold text-primary">
                {(dryRunConfig.riskPerTrade * 100).toFixed(1)}%
              </span>
              .
            </p>

            {/* Compounding Mode */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Compounding Mode
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => updateDryRunConfig({ compounding: true })}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors",
                    dryRunConfig.compounding
                      ? "border-primary bg-primary/10"
                      : "border-border hover:border-primary/50",
                  )}
                >
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <TrendingUp className="h-4 w-4" />
                    Auto-Compound
                  </div>
                  <span className="text-[10px] text-muted-foreground">Margin scales from accumulated profit</span>
                </button>
                <button
                  onClick={() => updateDryRunConfig({ compounding: false })}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-md border p-3 text-left transition-colors",
                    !dryRunConfig.compounding
                      ? "border-warning bg-warning/10"
                      : "border-border hover:border-warning/50",
                  )}
                >
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <Scale className="h-4 w-4" />
                    Fixed Size
                  </div>
                  <span className="text-[10px] text-muted-foreground">Margin fixed to initial balance ratio</span>
                </button>
              </div>
              {dryRunConfig.compounding && (
                <div className="flex items-start gap-2 rounded border border-primary/30 bg-primary/10 p-2 text-[11px] text-primary">
                  <TrendingUp className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    <strong>Compounding Active:</strong> AI Treasury Manager automatically adjusts position sizing based
                    on your current equity. As balance grows, so does your margin per trade.
                  </span>
                </div>
              )}
            </div>

            {/* Active Trading Symbol */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Active Trading Symbol
              </label>
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  value={tradingSettings.selectedSymbol}
                  onChange={(e) => updateTradingSettings({ selectedSymbol: e.target.value.toUpperCase() })}
                  placeholder="e.g. BTCUSDT"
                  className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-sm uppercase"
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                The primary symbol the engine focuses on. The screener will also track top volatile pairs automatically.
              </p>
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

      {/* ---- Flexible (preset-based) risk model ---- */}
      <RiskTradePanel
        risk={tradingSettings.riskModel}
        updateRiskModel={updateRiskModel}
        applyRiskPreset={applyRiskPreset}
      />

        <SystemPathsPanel />
        <ApiKeysPanel cexes={tradingSettings.cexes} />
    </div>
  )
}

function RiskTradePanel({
  risk,
  updateRiskModel,
  applyRiskPreset,
}: {
  risk: RiskModel
  updateRiskModel: (patch: Partial<RiskModel>) => void
  applyRiskPreset: (preset: RiskPreset) => void
}) {
  const isPreset =
    RISK_PRESETS[risk.preset] &&
    RISK_PRESETS[risk.preset].atrMultiplier === risk.atrMultiplier &&
    RISK_PRESETS[risk.preset].riskReward === risk.riskReward &&
    RISK_PRESETS[risk.preset].targetRoiPct === risk.targetRoiPct &&
    RISK_PRESETS[risk.preset].maxPnlPct === risk.maxPnlPct

  return (
    <Panel
      title="Risk Trade — Flexible Model"
      right={<Tag tone={isPreset ? "primary" : "outline"}>{isPreset ? risk.preset.toUpperCase() : "CUSTOM"}</Tag>}
    >
      <div className="space-y-4 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Risk is configured from a controlled set of safe values — no free-form numbers, so the engine can never be
          pushed into an invalid state. Start from a preset, then fine-tune each metric from its allowed options.
        </p>

        {risk.preset === "custom_auto" && (
          <div className="flex items-start gap-2 rounded border border-primary/30 bg-primary/10 p-2 text-[11px] text-primary">
            <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong>Auto-Pilot Active:</strong> The Style Agents are actively scanning History, Backtest Data, and Position Timeframes to dynamically adjust your Leverage and Risk levels.
            </span>
          </div>
        )}

        {/* Presets */}
        <div className="space-y-1.5">
          <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Risk Preset</label>
          <div className="grid grid-cols-3 gap-2">
            {RISK_PRESET_META.map((p) => (
              <button
                key={p.id}
                onClick={() => applyRiskPreset(p.id)}
                title={p.hint}
                className={cn(
                  "flex flex-col items-start gap-0.5 rounded border p-2 text-left transition-colors",
                  isPreset && risk.preset === p.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50",
                )}
              >
                <span className="text-xs font-semibold">{p.label}</span>
                <span className="text-[9px] leading-tight text-muted-foreground">{p.hint}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <RiskMetric
            icon={<Activity className="h-3.5 w-3.5" />}
            label="ATR (Stop Multiplier)"
            hint="Stop-loss distance = ATR × multiplier"
            options={RISK_OPTIONS.atrMultiplier}
            value={risk.atrMultiplier}
            format={(v) => `${v}×`}
            onSelect={(v) => updateRiskModel({ atrMultiplier: v })}
          />
          <RiskMetric
            icon={<Scale className="h-3.5 w-3.5" />}
            label="RR (Risk : Reward)"
            hint="Reward target relative to risk"
            options={RISK_OPTIONS.riskReward}
            value={risk.riskReward}
            format={(v) => `1 : ${v}`}
            onSelect={(v) => updateRiskModel({ riskReward: v })}
          />
          <RiskMetric
            icon={<Target className="h-3.5 w-3.5" />}
            label="ROI (Target / Position)"
            hint="Take-profit return target"
            options={RISK_OPTIONS.targetRoiPct}
            value={risk.targetRoiPct}
            format={(v) => `${v}%`}
            onSelect={(v) => updateRiskModel({ targetRoiPct: v })}
          />
          <RiskMetric
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="PNL (Max Risk / Trade)"
            hint="Caps risk-per-trade sizing"
            options={RISK_OPTIONS.maxPnlPct}
            value={risk.maxPnlPct}
            format={(v) => `${v}%`}
            onSelect={(v) => updateRiskModel({ maxPnlPct: v })}
          />
        </div>

        <div className="flex items-center gap-2 rounded border border-border bg-background px-2.5 py-2 text-[11px] text-muted-foreground">
          <Gauge className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span>
            Effective risk-per-trade derived from PNL:{" "}
            <span className="font-mono font-semibold text-primary">{risk.maxPnlPct}%</span> · expected reward at RR{" "}
            <span className="font-mono font-semibold text-positive">
              {(risk.maxPnlPct * risk.riskReward).toFixed(1)}%
            </span>
          </span>
        </div>
      </div>
    </Panel>
  )
}

function RiskMetric({
  icon,
  label,
  hint,
  options,
  value,
  format,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  hint: string
  options: readonly number[]
  value: number
  format: (v: number) => string
  onSelect: (v: number) => void
}) {
  return (
    <div className="space-y-1.5 rounded border border-border bg-background p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => (
          <button
            key={opt}
            onClick={() => onSelect(opt)}
            className={cn(
              "rounded border px-2.5 py-1 font-mono text-xs font-semibold transition-colors",
              value === opt
                ? "border-primary bg-primary/15 text-primary"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
          >
            {format(opt)}
          </button>
        ))}
      </div>
      <p className="text-[9px] leading-tight text-muted-foreground">{hint}</p>
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

function SystemPathsPanel() {
  const [dbPath, setDbPath] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    fetch(`${ENGINE_URL}/api/get-env`)
      .then((r) => r.json())
      .then((d) => {
        if (d?.env) {
          setDbPath(d.env.BOT_DB_PATH || "")
        }
      })
      .catch((err) => console.error("Failed to load env:", err))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await fetch(`${ENGINE_URL}/api/save-env`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          BOT_DB_PATH: dbPath,
        }),
      })
      // Minimal feedback
      setTimeout(() => setSaving(false), 500)
    } catch (err) {
      console.error("Failed to save env:", err)
      setSaving(false)
    }
  }

  return (
    <Panel
      title="System Paths & Databases"
      right={<Tag tone="primary">LOCAL STORAGE</Tag>}
    >
      <div className="space-y-3 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Configure the root directory where the system stores Big Data, Parquet, and ORC files. The engine will automatically create <span className="font-mono text-foreground">\parquet\bigdata</span> and <span className="font-mono text-foreground">\orc\agents</span> subfolders.
        </p>

        <div className="grid gap-3">
          <div className="space-y-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Base Database Path
            </label>
            <input
              type="text"
              value={dbPath}
              onChange={(e) => setDbPath(e.target.value)}
              placeholder="D:\database"
              className="w-full rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs placeholder:text-muted-foreground/50"
            />
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save Paths"}
          </button>
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
          Exchange credentials are read by the <span className="font-semibold">local Go engine</span> from environment
          variables — they are never stored in this dashboard or the browser. Add these keys to a local{" "}
          <span className="font-mono">.env</span> file next to the engine that runs the bot on your machine. The
          deployed dashboard (e.g. on Vercel) connects to that local engine via{" "}
          <span className="font-mono">NEXT_PUBLIC_ENGINE_URL</span>; when the engine isn&apos;t reachable the terminal
          stays read-only and your settings &amp; backtests still load from local storage.
        </p>

        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {cexes.map((cex) => {
            const vars = [cex.apiKeyEnv, cex.apiSecretEnv, ...(cex.passphraseEnv ? [cex.passphraseEnv] : [])].filter(Boolean)
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
