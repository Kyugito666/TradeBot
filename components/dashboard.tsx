"use client"

import { useMemo, useState } from "react"
import { WifiOff, Play, ToggleLeft, ToggleRight } from "lucide-react"
import { useLiveData } from "@/hooks/use-live-data"
import { NavRail, type TabId } from "./nav-rail"
import { CommandBar } from "./command-bar"
import { KpiStrip } from "./kpi-strip"
import { SignalWatch } from "./signal-watch"
import { SignalPanel } from "./signal-panel"
import { ConsensusPanel } from "./consensus-panel"
import { AgentConsensusPanel } from "./agent-consensus-panel"
import { PositionsTable } from "./positions-table"
import { RiskPanel } from "./risk-panel"
import { PerformancePanel } from "./performance-panel"
import { EventLog } from "./event-log"
import { AnalysisProgress } from "./analysis-progress"
import { AgentVotesPanel } from "./agent-votes-panel"
import { SettingsPanel } from "./settings-panel"
import { BacktestPanel } from "./backtest-panel"
import { ENGINE_URL } from "@/lib/engine"
import { Panel, Tag } from "./ui-kit"
import { cn } from "@/lib/utils"
import { num } from "@/lib/format"

export function Dashboard() {
  const { 
    snapshot, 
    start, 
    stop, 
    refresh,
    agentAnalysis,
    isAnalyzing,
    analysisSymbol,
    runAnalysis,
    pendingForecast,
    lastGrade,
    dryRunConfig,
    toggleDryRun,
    updateDryRunConfig,
    tradingSettings,
    updateTradingSettings,
    updateCexConfig,
    updateRiskModel,
    applyRiskPreset,
    backtests,
    isBacktesting,
    runBacktest,
    clearBacktests,
    pairStats
  } = useLiveData()
  const [tab, setTab] = useState<TabId>("overview")
  const online = snapshot.engineOnline

  // Fully DYNAMIC analysis universe: the real, live pair list of the ACTIVE
  // exchange (never hardcoded). Pairs that already have backtest stats are ranked
  // first (by expectancy) so Backtest, Signals & Consensus all surface the same
  // best pairs; the rest keep the exchange's liquidity order.
  const analyzeSymbols = useMemo(() => {
    const syms = snapshot.market.map((m) => m.symbol)
    return [...syms]
      .sort((a, b) => (pairStats[b]?.expectancyR ?? Number.NEGATIVE_INFINITY) - (pairStats[a]?.expectancyR ?? Number.NEGATIVE_INFINITY))
      .slice(0, 12)
  }, [snapshot.market, pairStats])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <NavRail active={tab} onChange={setTab} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CommandBar snapshot={snapshot} onStart={start} onStop={stop} onRefresh={refresh} />

        {/* Dry-run mode indicator */}
        {dryRunConfig.enabled && (
          <div className="flex flex-wrap items-center gap-2 border-b border-primary/30 bg-primary/10 px-4 py-2 text-[11px] text-primary">
            <Tag tone="primary">DRY-RUN MODE</Tag>
            <span className="text-primary/80">
              Paper trading enabled. No real orders will be executed. Balance: ${num(dryRunConfig.initialBalance, 0)}
            </span>
            <button
              onClick={() => toggleDryRun(false)}
              className="ml-auto flex items-center gap-1 rounded border border-primary/30 px-2 py-0.5 hover:bg-primary/20 transition-colors"
            >
              <ToggleRight className="h-3 w-3" />
              <span>Disable</span>
            </button>
          </div>
        )}

        {!online && !dryRunConfig.enabled && (
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-[11px] text-warning">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span className="font-semibold">Trading engine offline.</span>
            <span className="text-warning/80">
              Signals &amp; consensus below are computed live from real market data. Connect your engine (gateway on{" "}
              <span className="font-mono">{ENGINE_URL}</span>) to enable live positions, P&amp;L and execution logs. Set{" "}
              <span className="font-mono">NEXT_PUBLIC_ENGINE_URL</span> to point at a remote engine.
            </span>
            <button
              onClick={() => toggleDryRun(true)}
              className="ml-auto flex items-center gap-1 rounded border border-warning/30 px-2 py-0.5 hover:bg-warning/20 transition-colors"
            >
              <ToggleLeft className="h-3 w-3" />
              <span>Enable Dry-Run</span>
            </button>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-auto scroll-thin bg-terminal-grid p-3">
          {tab === "overview" && (
            <div className="flex flex-col gap-3">
              <KpiStrip snapshot={snapshot} />
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_320px]">
                <div className="flex min-w-0 flex-col gap-3">
                  {/* Analysis Progress Panel */}
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <AnalysisProgress 
                      progress={agentAnalysis?.progress ?? null}
                    />
                    <Panel 
                      title="Run Analysis" 
                      right={
                        <Tag tone={isAnalyzing ? "warning" : "positive"}>
                          {isAnalyzing ? "RUNNING" : "READY"}
                        </Tag>
                      }
                    >
                      <div className="p-3 space-y-3">
                        <p className="text-[11px] text-muted-foreground">
                          Run the multi-agent analysis pipeline on any live pair of the active exchange to get a
                          consensus signal with full progress tracking.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {analyzeSymbols.length === 0 && (
                            <span className="text-[11px] text-muted-foreground">Loading live pairs…</span>
                          )}
                          {analyzeSymbols.map((sym) => (
                            <button
                              key={sym}
                              onClick={() => runAnalysis(sym)}
                              disabled={isAnalyzing}
                              className={cn(
                                "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors",
                                analysisSymbol === sym && !isAnalyzing
                                  ? "border-primary bg-primary/15 text-primary"
                                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary",
                                isAnalyzing && "opacity-50 cursor-not-allowed"
                              )}
                            >
                              <Play className="h-3 w-3" />
                              {sym.replace("USDT", "")}
                            </button>
                          ))}
                        </div>
                        {agentAnalysis?.consensus && (
                          <div className={cn(
                            "rounded border p-2 text-center",
                            agentAnalysis.consensus.signal === "LONG" && "border-positive/30 bg-positive/10",
                            agentAnalysis.consensus.signal === "SHORT" && "border-negative/30 bg-negative/10",
                            agentAnalysis.consensus.signal === "WAIT" && "border-warning/30 bg-warning/10"
                          )}>
                            <div className={cn(
                              "font-mono text-xl font-bold",
                              agentAnalysis.consensus.signal === "LONG" && "text-positive",
                              agentAnalysis.consensus.signal === "SHORT" && "text-negative",
                              agentAnalysis.consensus.signal === "WAIT" && "text-warning"
                            )}>
                              {agentAnalysis.consensus.signal}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              Confidence: {(agentAnalysis.consensus.confidence * 100).toFixed(1)}%
                            </div>
                          </div>
                        )}
                      </div>
                    </Panel>
                  </div>
                  
                  <SignalWatch market={snapshot.market} marketOnline={snapshot.marketOnline} />
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <PerformancePanel performance={snapshot.performance} engineOnline={online} />
                    <RiskPanel risk={snapshot.risk} engineOnline={online} />
                  </div>
                  <PositionsTable positions={snapshot.positions} engineOnline={online} />
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                  <ConsensusPanel consensus={snapshot.consensus} engineOnline={online} />
                  {/* Agent Votes Panel */}
                  {agentAnalysis?.agentOutputs && agentAnalysis.agentOutputs.length > 0 && (
                    <AgentVotesPanel
                      outputs={agentAnalysis.agentOutputs}
                      agents={agentAnalysis.agents || []}
                      evolution={{
                        team: agentAnalysis.evolution?.team,
                        agents: agentAnalysis.evolution?.agents as any,
                        recentReports: agentAnalysis.evolution?.recentReports
                      }}
                    />
                  )}
                  <EventLog log={snapshot.log} engineOnline={online} />
                </div>
              </div>
            </div>
          )}

          {tab === "signals" && (
            <SignalPanel
              market={snapshot.market}
              marketOnline={snapshot.marketOnline}
              tradingSettings={tradingSettings}
              agentAnalysis={agentAnalysis}
              pairStats={pairStats}
            />
          )}

          {tab === "consensus" && (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_360px]">
              <div className="flex flex-col gap-3">
                {/* Symbol selector — every agent runs live on the chosen market */}
                <Panel
                  title="Agent Team"
                  right={
                    <Tag tone={isAnalyzing ? "warning" : "positive"}>
                      {isAnalyzing ? "ANALYZING" : "LIVE"}
                    </Tag>
                  }
                >
                  <div className="flex flex-col gap-2 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] text-muted-foreground">Analyze:</span>
                      {analyzeSymbols.length === 0 && (
                        <span className="text-[11px] text-muted-foreground">Loading live pairs from the active exchange…</span>
                      )}
                      {analyzeSymbols.map((sym) => {
                        const stat = pairStats[sym]
                        return (
                          <button
                            key={sym}
                            onClick={() => runAnalysis(sym)}
                            disabled={isAnalyzing}
                            title={stat ? `Backtest: ${stat.winRate}% WR · ${stat.expectancyR >= 0 ? "+" : ""}${stat.expectancyR}R exp` : undefined}
                            className={cn(
                              "flex items-center gap-1.5 rounded border px-3 py-1.5 text-xs font-semibold transition-colors",
                              analysisSymbol === sym && !isAnalyzing
                                ? "border-primary bg-primary/15 text-primary"
                                : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary",
                              isAnalyzing && "opacity-50 cursor-not-allowed",
                            )}
                          >
                            <Play className="h-3 w-3" />
                            {sym.replace("USDT", "")}
                            {stat && (
                              <span className={cn("ml-0.5 font-mono text-[9px]", stat.expectancyR >= 0 ? "text-positive" : "text-negative")}>
                                {stat.winRate}%
                              </span>
                            )}
                          </button>
                        )
                      })}
                    </div>
                    {/* Full dynamic universe — pick ANY real pair listed on the active exchange */}
                    {snapshot.market.length > 0 && (
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-muted-foreground">All pairs:</span>
                        <select
                          value={analysisSymbol}
                          disabled={isAnalyzing}
                          onChange={(e) => runAnalysis(e.target.value)}
                          className="rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground disabled:opacity-50"
                        >
                          {snapshot.market.map((m) => (
                            <option key={m.symbol} value={m.symbol}>
                              {m.symbol.replace("USDT", "/USDT")}
                            </option>
                          ))}
                        </select>
                        <span className="text-[10px] text-muted-foreground">{snapshot.market.length} live pairs</span>
                      </div>
                    )}
                  </div>
                </Panel>
                <AnalysisProgress progress={agentAnalysis?.progress ?? null} />
                {/* Live agent activity — every agent runs and shows its current read */}
                {agentAnalysis?.agentOutputs && (
                  <AgentVotesPanel
                    outputs={agentAnalysis.agentOutputs}
                    agents={agentAnalysis.agents || []}
                    evolution={{
                      team: agentAnalysis.evolution?.team,
                      agents: agentAnalysis.evolution?.agents as any,
                      recentReports: agentAnalysis.evolution?.recentReports
                    }}
                  />
                )}
              </div>
              <AgentConsensusPanel
                consensus={agentAnalysis?.consensus}
                symbol={agentAnalysis?.symbol ?? analysisSymbol}
                pendingForecast={pendingForecast}
                lastGrade={lastGrade}
              />
            </div>
          )}

          {tab === "positions" && (
            <div className="flex flex-col gap-3">
              <KpiStrip snapshot={snapshot} />
              <PositionsTable positions={snapshot.positions} engineOnline={online} />
            </div>
          )}

          {tab === "risk" && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <RiskPanel risk={snapshot.risk} engineOnline={online} />
              <PerformancePanel performance={snapshot.performance} engineOnline={online} />
            </div>
          )}

          {tab === "performance" && (
            <div className="flex flex-col gap-3">
              <KpiStrip snapshot={snapshot} />
              <PerformancePanel performance={snapshot.performance} engineOnline={online} />
            </div>
          )}

          {tab === "logs" && (
            <div className="h-[calc(100vh-8rem)]">
              <EventLog log={snapshot.log} engineOnline={online} className="h-full" />
            </div>
          )}
          
          {/* Mode & Settings tab */}
          {tab === "settings" && (
            <SettingsPanel
              dryRunConfig={dryRunConfig}
              toggleDryRun={toggleDryRun}
              updateDryRunConfig={updateDryRunConfig}
              tradingSettings={tradingSettings}
              updateTradingSettings={updateTradingSettings}
              updateCexConfig={updateCexConfig}
              updateRiskModel={updateRiskModel}
              applyRiskPreset={applyRiskPreset}
            />
          )}

          {/* Backtest tab */}
          {tab === "backtest" && (
            <BacktestPanel
              backtests={backtests}
              isBacktesting={isBacktesting}
              runBacktest={runBacktest}
              clearBacktests={clearBacktests}
            />
          )}
        </main>
      </div>
    </div>
  )
}
