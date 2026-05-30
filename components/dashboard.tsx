"use client"

import { useLiveData } from "@/hooks/use-live-data"
import { NavRail } from "./nav-rail"
import { CommandBar } from "./command-bar"
import { KpiStrip } from "./kpi-strip"
import { SignalWatch } from "./signal-watch"
import { ConsensusPanel } from "./consensus-panel"
import { PositionsTable } from "./positions-table"
import { RiskPanel } from "./risk-panel"
import { PerformancePanel } from "./performance-panel"
import { EventLog } from "./event-log"

export function Dashboard() {
  const { snapshot, setMode, toggleKillSwitch } = useLiveData(2000)

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <CommandBar snapshot={snapshot} onMode={setMode} onToggleKill={toggleKillSwitch} />
        <main className="min-h-0 flex-1 overflow-auto scroll-thin bg-terminal-grid p-3">
          <div className="flex flex-col gap-3">
            <KpiStrip snapshot={snapshot} />

            {/* primary working area */}
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_320px]">
              <div className="flex min-w-0 flex-col gap-3">
                <SignalWatch market={snapshot.market} />
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <PerformancePanel performance={snapshot.performance} />
                  <RiskPanel risk={snapshot.risk} />
                </div>
                <PositionsTable positions={snapshot.positions} />
              </div>

              {/* right column: consensus + live event stream */}
              <div className="flex min-w-0 flex-col gap-3">
                <ConsensusPanel consensus={snapshot.consensus} />
                <EventLog log={snapshot.log} />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
