"use client"

import { useState } from "react"
import { WifiOff, Brain, Play, ToggleLeft, ToggleRight, DollarSign, Percent } from "lucide-react"
import { useLiveData } from "@/hooks/use-live-data"
import { NavRail, type TabId } from "./nav-rail"
import { CommandBar } from "./command-bar"
import { KpiStrip } from "./kpi-strip"
import { SignalWatch } from "./signal-watch"
import { ConsensusPanel } from "./consensus-panel"
import { PositionsTable } from "./positions-table"
import { RiskPanel } from "./risk-panel"
import { PerformancePanel } from "./performance-panel"
import { EventLog } from "./event-log"
import { AnalysisProgress } from "./analysis-progress"
import { AgentVotesPanel } from "./agent-votes-panel"
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
    dryRunConfig,
    toggleDryRun,
    updateDryRunConfig
  } = useLiveData()
  const [tab, setTab] = useState<TabId>("overview")
  const online = snapshot.engineOnline

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
                          Run the multi-agent analysis pipeline on a specific symbol to get consensus signal with full progress tracking.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"].map((sym) => (
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
            <div className="flex flex-col gap-3">
              <KpiStrip snapshot={snapshot} />
              <SignalWatch market={snapshot.market} marketOnline={snapshot.marketOnline} />
            </div>
          )}

          {tab === "consensus" && (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_360px]">
              <div className="flex flex-col gap-3">
                <SignalWatch market={snapshot.market} marketOnline={snapshot.marketOnline} />
                {/* Agent analysis section */}
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <AnalysisProgress progress={agentAnalysis?.progress ?? null} />
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
              </div>
              <ConsensusPanel consensus={snapshot.consensus} engineOnline={online} />
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
          
          {/* Agents tab - dedicated view for agent analysis */}
          {tab === "agents" && (
            <div className="flex flex-col gap-3">
              <KpiStrip snapshot={snapshot} />
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_400px]">
                <div className="flex flex-col gap-3">
                  {/* Analysis control */}
                  <Panel 
                    title="Multi-Agent Analysis Pipeline" 
                    right={
                      <div className="flex items-center gap-2">
                        <Tag tone={isAnalyzing ? "warning" : "positive"}>
                          {isAnalyzing ? "ANALYZING" : "READY"}
                        </Tag>
                        {agentAnalysis?.agents && (
                          <Tag tone="primary">{agentAnalysis.agents.length} AGENTS</Tag>
                        )}
                      </div>
                    }
                  >
                    <div className="p-4 space-y-4">
                      <p className="text-sm text-muted-foreground">
                        Run the quant-style multi-agent analysis to get consensus signals. Each agent analyzes 
                        different factors (trend, momentum, sentiment, risk) and votes on direction. The pipeline 
                        tracks progress and never stops at 2/3 - it completes all 6 stages.
                      </p>
                      
                      <div className="flex flex-wrap gap-2">
                        {snapshot.market.map((m) => (
                          <button
                            key={m.symbol}
                            onClick={() => runAnalysis(m.symbol)}
                            disabled={isAnalyzing}
                            className={cn(
                              "flex items-center gap-2 rounded border px-3 py-2 text-sm font-semibold transition-colors",
                              analysisSymbol === m.symbol && !isAnalyzing
                                ? "border-primary bg-primary/15 text-primary"
                                : "border-border text-muted-foreground hover:border-primary/50 hover:text-primary",
                              isAnalyzing && "opacity-50 cursor-not-allowed"
                            )}
                          >
                            <Brain className="h-4 w-4" />
                            <span>{m.symbol.replace("USDT", "")}</span>
                            <span className={cn(
                              "font-mono text-xs",
                              m.pct24h >= 0 ? "text-positive" : "text-negative"
                            )}>
                              {m.pct24h >= 0 ? "+" : ""}{m.pct24h.toFixed(2)}%
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </Panel>
                  
                  <AnalysisProgress progress={agentAnalysis?.progress ?? null} />
                  
                  {/* Agent outputs */}
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
                
                <div className="flex flex-col gap-3">
                  {/* Consensus result */}
                  {agentAnalysis?.consensus && (
                    <Panel title="Agent Consensus">
                      <div className={cn(
                        "p-4",
                        agentAnalysis.consensus.signal === "LONG" && "bg-positive/5",
                        agentAnalysis.consensus.signal === "SHORT" && "bg-negative/5",
                        agentAnalysis.consensus.signal === "WAIT" && "bg-warning/5"
                      )}>
                        <div className="text-center mb-4">
                          <div className={cn(
                            "font-mono text-4xl font-bold",
                            agentAnalysis.consensus.signal === "LONG" && "text-positive",
                            agentAnalysis.consensus.signal === "SHORT" && "text-negative",
                            agentAnalysis.consensus.signal === "WAIT" && "text-warning"
                          )}>
                            {agentAnalysis.consensus.signal}
                          </div>
                          <div className="text-sm text-muted-foreground mt-1">
                            {(agentAnalysis.consensus.confidence * 100).toFixed(1)}% confidence
                          </div>
                        </div>
                        
                        <div className="space-y-3 text-sm">
                          <div className="grid grid-cols-3 gap-2 text-center">
                            <div>
                              <div className="font-mono font-bold">${num(agentAnalysis.consensus.entry, 0)}</div>
                              <div className="text-[10px] text-muted-foreground">Entry</div>
                            </div>
                            <div>
                              <div className="font-mono font-bold text-positive">${num(agentAnalysis.consensus.tp, 0)}</div>
                              <div className="text-[10px] text-muted-foreground">Take Profit</div>
                            </div>
                            <div>
                              <div className="font-mono font-bold text-negative">${num(agentAnalysis.consensus.sl, 0)}</div>
                              <div className="text-[10px] text-muted-foreground">Stop Loss</div>
                            </div>
                          </div>
                          
                          <div className="border-t border-border pt-3">
                            <p className="text-[11px] text-muted-foreground leading-relaxed">
                              {agentAnalysis.consensus.reasoning}
                            </p>
                          </div>
                          
                          {agentAnalysis.consensus.agreeingAgents.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="text-[10px] text-muted-foreground">Agreeing:</span>
                              {agentAnalysis.consensus.agreeingAgents.map((a) => (
                                <Tag key={a} tone="positive">{a}</Tag>
                              ))}
                            </div>
                          )}
                          
                          {agentAnalysis.consensus.dissentingAgents.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="text-[10px] text-muted-foreground">Dissenting:</span>
                              {agentAnalysis.consensus.dissentingAgents.map((a) => (
                                <Tag key={a} tone="negative">{a}</Tag>
                              ))}
                            </div>
                          )}
                          
                          {agentAnalysis.consensus.vetoAgents.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              <span className="text-[10px] text-muted-foreground">Veto:</span>
                              {agentAnalysis.consensus.vetoAgents.map((a) => (
                                <Tag key={a} tone="negative">{a}</Tag>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </Panel>
                  )}
                  
                  {/* Dry-run settings */}
                  <Panel title="Paper Trading Settings">
                    <div className="p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-sm font-semibold">Dry-Run Mode</div>
                          <div className="text-[10px] text-muted-foreground">
                            Simulate trades without real execution
                          </div>
                        </div>
                        <button
                          onClick={() => toggleDryRun()}
                          className={cn(
                            "flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                            dryRunConfig.enabled
                              ? "bg-positive/15 text-positive"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {dryRunConfig.enabled ? (
                            <>
                              <ToggleRight className="h-4 w-4" />
                              ENABLED
                            </>
                          ) : (
                            <>
                              <ToggleLeft className="h-4 w-4" />
                              DISABLED
                            </>
                          )}
                        </button>
                      </div>
                      
                      {dryRunConfig.enabled && (
                        <>
                          <div className="space-y-1">
                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              Initial Balance
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
                              Risk Per Trade
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
                        </>
                      )}
                    </div>
                  </Panel>
                  
                  <EventLog log={snapshot.log} engineOnline={online} />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
