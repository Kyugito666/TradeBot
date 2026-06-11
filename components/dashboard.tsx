"use client"

import { useMemo, useState } from "react"
import { WifiOff, Play, ToggleLeft, ToggleRight } from "lucide-react"
import { useLiveData } from "@/hooks/use-live-data"
import { useSignalTrades } from "@/hooks/use-signal-trades"
import { NavRail, type TabId } from "./nav-rail"
import { CommandBar } from "./command-bar"
import { KpiStrip } from "./kpi-strip"
import { SymbolSelector } from "./symbol-selector"
import { SignalWatch } from "./signal-watch"
import { SignalPanel } from "./signal-panel"
import { ConsensusPanel } from "./consensus-panel"
import { AgentConsensusPanel } from "./agent-consensus-panel"
import { PositionsTable } from "./positions-table"
import { TradeHistoryTable } from "./trade-history-table"
import { RiskPanel } from "./risk-panel"
import { PerformancePanel } from "./performance-panel"
import { EventLog } from "./event-log"
import { AnalysisProgress } from "./analysis-progress"
import { AgentVotesPanel } from "./agent-votes-panel"
import { SettingsPanel } from "./settings-panel"
import { BacktestPanel } from "./backtest-panel"
import BigDataPanel from "./bigdata-panel"
import { RoomStatusStrip } from "./room-status"
import { QuantPanel } from "./quant-panel"
import { ShadowPanel } from "./shadow-panel"
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
    saveBacktestResult,
    pairStats
  } = useLiveData()
  const [tab, setTab] = useState<TabId>("overview")
  const online = snapshot.engineOnline

  const activeCex = tradingSettings.cexes.find((c) => c.id === tradingSettings.activeCex)
  const signalEngine = useSignalTrades({
    market: snapshot.market,
    marketOnline: snapshot.marketOnline,
    style: tradingSettings.tradingStyle,
    risk: tradingSettings.riskModel,
    activeCex,
    agentAnalysis,
    paperBalance: dryRunConfig.initialBalance,
  })

  const displaySnapshot = useMemo(() => {
    if (!dryRunConfig.enabled) return snapshot

    const paperPositions = signalEngine.open.map(t => {
      const mark = snapshot.market.find((m) => m.symbol === t.symbol)?.lastPrice || t.entry
      const dir = t.side === "LONG" ? 1 : -1
      
      const activeCex = tradingSettings.cexes.find((c) => c.id === tradingSettings.activeCex)
      const pairLev = activeCex?.pairLeverage?.find(p => p.pair === t.symbol)?.leverage
      const realLeverage = pairLev || activeCex?.defaultLeverage || 1
      
      const roe = ((mark - t.entry) / t.entry) * dir * realLeverage * 100
      const tradeMargin = Number(t.margin) || (dryRunConfig.initialBalance * dryRunConfig.riskPerTrade)
      return {
        id: t.id,
        symbol: t.symbol,
        side: t.side as "LONG" | "SHORT",
        entry: t.entry,
        mark,
        tp: t.tp,
        sl: t.sl,
        margin: tradeMargin,
        leverage: realLeverage,
        pnlPct: roe,
        pnlUsd: tradeMargin * (roe / 100),
        status: "OPEN",
        openedAt: new Date(t.openedAt).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      }
    })

    let rollingEq = dryRunConfig.initialBalance
    const curve = [{ t: Date.now() - 86400000, equity: rollingEq }] // Base start point

    const realized = signalEngine.history.map(t => {
      const tradeMargin = Number(t.margin) || (dryRunConfig.initialBalance * dryRunConfig.riskPerTrade)
      const pnl = tradeMargin * ((t.pnlPct || 0) / 100)
      rollingEq += pnl
      if (t.closedAt) {
        curve.push({ t: t.closedAt, equity: rollingEq })
      }
      return pnl
    })
    
    const wins = realized.filter((r) => r > 0)
    const losses = realized.filter((r) => r < 0)
    const grossWin = wins.reduce((a, b) => a + b, 0)
    const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))
    const realizedPnl = realized.reduce((a, b) => a + b, 0)
    const paperEquity = dryRunConfig.initialBalance + realizedPnl

    const pf = grossLoss === 0 ? (grossWin > 0 ? 99 : 0) : grossWin / grossLoss
    const winRate = realized.length > 0 ? (wins.length / realized.length) * 100 : 0
    const marginUsed = paperPositions.reduce((a, b) => a + b.margin, 0)
    const unrealized = paperPositions.reduce((a, b) => a + b.pnlUsd, 0)
    const activeEquity = paperEquity + unrealized

    const paperPerformance = {
      curve: curve,
      totalReturnPct: (realizedPnl / dryRunConfig.initialBalance) * 100,
      todayPct: (realizedPnl / dryRunConfig.initialBalance) * 100,
      realizedPnl,
      winRate,
      profitFactor: pf,
      trades: realized.length,
      wins: wins.length,
      losses: losses.length,
      avgWin: wins.length > 0 ? grossWin / wins.length : 0,
      avgLoss: losses.length > 0 ? grossLoss / losses.length : 0,
      bestTrade: realized.length > 0 ? Math.max(...realized) : 0,
      worstTrade: realized.length > 0 ? Math.min(...realized) : 0,
    }

    const paperRisk = {
      ...snapshot.risk,
      dryRun: true,
      balance: paperEquity,
      equity: activeEquity,
      marginUsed,
      marginFree: Math.max(0, paperEquity - marginUsed),
      marginRatio: paperEquity > 0 ? Math.min(1, marginUsed / paperEquity) : 0,
      netExposure: paperPositions.reduce((a, b) => a + (b.side === "LONG" ? b.margin : -b.margin), 0),
      grossExposure: marginUsed,
      dailyPnl: realizedPnl + unrealized,
      openPositions: paperPositions.length,
    }

    return {
      ...snapshot,
      positions: paperPositions,
      performance: paperPerformance,
      risk: paperRisk,
    }
  }, [snapshot, signalEngine.open, signalEngine.history, dryRunConfig])

  // Fully DYNAMIC analysis universe: the real, live pair list of the ACTIVE
  // exchange (never hardcoded). Pairs that already have backtest stats are ranked
  // first (by expectancy) so Backtest, Signals & Consensus all surface the same
  // best pairs; the rest keep the exchange's liquidity order.
  const analyzeSymbols = useMemo(() => {
    const syms = displaySnapshot.market.map((m) => m.symbol)
    return [...syms]
      .sort((a, b) => (pairStats[b]?.expectancyR ?? Number.NEGATIVE_INFINITY) - (pairStats[a]?.expectancyR ?? Number.NEGATIVE_INFINITY))
      .slice(0, 12)
  }, [displaySnapshot.market, pairStats])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <NavRail active={tab} onChange={setTab} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CommandBar snapshot={displaySnapshot} onStart={start} onStop={stop} onRefresh={refresh} />

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
              <RoomStatusStrip />
              <QuantPanel />
              <KpiStrip snapshot={displaySnapshot} />
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_320px]">
                <div className="flex min-w-0 flex-col gap-3">
                  {/* Analysis Progress Panel */}
                  <AnalysisProgress 
                    progress={agentAnalysis?.progress ?? null}
                  />

                  <SignalWatch market={displaySnapshot.market} marketOnline={displaySnapshot.marketOnline} />
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <PerformancePanel performance={displaySnapshot.performance} engineOnline={online || dryRunConfig.enabled} />
                    <RiskPanel risk={displaySnapshot.risk} engineOnline={online || dryRunConfig.enabled} />
                  </div>
                  <PositionsTable positions={displaySnapshot.positions} engineOnline={online || dryRunConfig.enabled} className="max-h-[300px] flex flex-col" />
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                  <ConsensusPanel consensus={displaySnapshot.consensus} engineOnline={online || dryRunConfig.enabled} />
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
                  <EventLog log={displaySnapshot.log} engineOnline={online || dryRunConfig.enabled} className="max-h-[400px] flex flex-col" />
                </div>
              </div>
            </div>
          )}

          {tab === "signals" && (
            <SignalPanel
              market={displaySnapshot.market}
              marketOnline={displaySnapshot.marketOnline}
              tradingSettings={tradingSettings}
              agentAnalysis={agentAnalysis}
              pairStats={pairStats}
              paperBalance={dryRunConfig.initialBalance + (signalEngine.stats?.netPnlUsd || 0)}
              signalEngine={signalEngine}
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
                    <span className="text-[11px] text-muted-foreground">Select Pair to Analyze:</span>
                    <SymbolSelector
                      market={displaySnapshot.market}
                      pairStats={pairStats}
                      analysisSymbol={analysisSymbol}
                      isAnalyzing={isAnalyzing}
                      runAnalysis={runAnalysis}
                    />
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
              <KpiStrip snapshot={displaySnapshot} />
              <PositionsTable positions={displaySnapshot.positions} engineOnline={online || dryRunConfig.enabled} />
              <TradeHistoryTable history={signalEngine.history} fallbackMargin={dryRunConfig.initialBalance * dryRunConfig.riskPerTrade} />
            </div>
          )}

          {tab === "shadow" && (
            <ShadowPanel />
          )}

          {tab === "risk" && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              <RiskPanel risk={displaySnapshot.risk} engineOnline={online || dryRunConfig.enabled} />
              <PerformancePanel performance={displaySnapshot.performance} engineOnline={online || dryRunConfig.enabled} />
            </div>
          )}

          {tab === "performance" && (
            <div className="flex flex-col gap-3">
              <KpiStrip snapshot={displaySnapshot} />
              <PerformancePanel performance={displaySnapshot.performance} engineOnline={online || dryRunConfig.enabled} />
            </div>
          )}

          {tab === "logs" && (
            <div className="h-[calc(100vh-8rem)]">
              <EventLog log={displaySnapshot.log} engineOnline={online || dryRunConfig.enabled} className="h-full" />
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
              saveBacktestResult={saveBacktestResult}
              tradingSettings={tradingSettings}
              selectedSymbol={analysisSymbol}
              pairs={displaySnapshot.market.map((m) => m.symbol)}
            />
          )}

          {/* BigData tab */}
          {tab === "bigdata" && (
            <div className="space-y-4 p-4">
              <BigDataPanel />
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
