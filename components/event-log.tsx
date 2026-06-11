"use client"

import { useState } from "react"

import { ScrollText } from "lucide-react"
import type { LogEvent } from "@/lib/types"
import { Panel, EmptyState } from "./ui-kit"
import { cn } from "@/lib/utils"

const levelBg: Record<LogEvent["level"], string> = {
  INFO: "text-muted-foreground",
  SIGNAL: "text-blue-400",
  EXEC: "text-positive",
  RISK: "text-warning",
  VETO: "text-negative",
  WARNING: "text-warning",
  ERROR: "text-negative",
  DEBUG: "text-muted-foreground",
}

export function EventLog({
  log,
  engineOnline,
  className,
}: {
  log: LogEvent[]
  engineOnline: boolean
  className?: string
}) {
  const [filter, setFilter] = useState<"ALL" | "SIGNAL" | "EXEC" | "RISK" | "ERROR">("ALL")
  
  const filteredLog = log.filter(e => {
    if (filter === "ALL") return true
    if (filter === "ERROR" && (e.level === "ERROR" || e.level === "VETO")) return true
    return e.level === filter
  })

  return (
    <Panel
      title="Terminal Console"
      right={
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-muted/20 p-0.5 rounded border border-border/50">
            {(["ALL", "SIGNAL", "EXEC", "RISK", "ERROR"] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-2 py-0.5 text-[9px] font-mono font-bold rounded-sm transition-all", 
                  filter === f ? "bg-panel text-foreground shadow-sm border border-border/40" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <span className="text-[10px] font-mono text-muted-foreground">{filteredLog.length} / {log.length}</span>
        </div>
      }
      className={cn("bg-[#0a0a0a] border-border/40 shadow-inner", className)}
      bodyClassName="overflow-auto scroll-thin flex-1"
    >
      {filteredLog.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={engineOnline ? (filter === "ALL" ? "System idle" : `No ${filter} events`) : "Connection severed"}
          hint={
            engineOnline
              ? "Awaiting execution matrix inputs..."
              : "Start the local engine to establish uplink."
          }
          className="h-full min-h-32 opacity-50"
        />
      ) : (
        <div className="flex flex-col p-2 space-y-1 font-mono text-[11px] leading-tight selection:bg-primary/30">
          {filteredLog.map((e) => (
            <div key={e.id} className="flex items-start gap-2 group hover:bg-muted/10 px-1 py-0.5 rounded transition-colors">
              <span className="shrink-0 opacity-40 group-hover:opacity-70 transition-opacity">[{e.time}]</span>
              <span className={cn("shrink-0 font-bold tracking-widest uppercase w-[60px]", levelBg[e.level])}>
                {e.level}
              </span>
              <span className="min-w-0 flex-1 text-foreground/80 break-words">
                {e.name && <span className="text-foreground/50 mr-2">{"<"}{e.name}{">"}</span>}
                {e.message}
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 px-1 py-1 mt-2 opacity-50">
            <span className="text-primary font-bold">{">"}</span>
            <span className="w-2 h-3 bg-primary animate-pulse"></span>
          </div>
        </div>
      )}
    </Panel>
  )
}
