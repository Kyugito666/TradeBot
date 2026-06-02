"use client"

import { useState } from "react"
import { WifiOff } from "lucide-react"
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
import { ENGINE_URL } from "@/lib/engine"

export function Dashboard() {
  const { snapshot, start, stop, refresh } = useLiveData()
  const [tab, setTab] = useState<TabId>("overview")
  const online = snapshot.engineOnline

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <NavRail active={tab} onChange={setTab} />
      <div className="flex min-w-0 flex-1 flex-col">
        <CommandBar snapshot={snapshot} onStart={start} onStop={stop} onRefresh={refresh} />

        {!online && (
          <div className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-[11px] text-warning">
            <WifiOff className="h-3.5 w-3.5 shrink-0" />
            <span className="font-semibold">Trading engine offline.</span>
            <span className="text-warning/80">
              Signals &amp; consensus below are computed live from real market data. Connect your engine (gateway on{" "}
              <span className="font-mono">{ENGINE_URL}</span>) to enable live positions, P&amp;L and execution logs. Set{" "}
              <span className="font-mono">NEXT_PUBLIC_ENGINE_URL</span> to point at a remote engine.
            </span>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-auto scroll-thin bg-terminal-grid p-3">
          {tab === "overview" && (
            <div className="flex flex-col gap-3">
              <KpiStrip snapshot={snapshot} />
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_320px]">
                <div className="flex min-w-0 flex-col gap-3">
                  <SignalWatch market={snapshot.market} marketOnline={snapshot.marketOnline} />
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                    <PerformancePanel performance={snapshot.performance} engineOnline={online} />
                    <RiskPanel risk={snapshot.risk} engineOnline={online} />
                  </div>
                  <PositionsTable positions={snapshot.positions} engineOnline={online} />
                </div>
                <div className="flex min-w-0 flex-col gap-3">
                  <ConsensusPanel consensus={snapshot.consensus} engineOnline={online} />
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
              <SignalWatch market={snapshot.market} marketOnline={snapshot.marketOnline} />
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
        </main>
      </div>
    </div>
  )
}
