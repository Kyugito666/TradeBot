"use client"

import { WifiOff } from "lucide-react"
import type { LogEvent } from "@/lib/types"
import { Panel } from "./ui-kit"
import { cn } from "@/lib/utils"

const levelBg: Record<LogEvent["level"], string> = {
  INFO: "bg-muted text-muted-foreground",
  SIGNAL: "bg-primary/15 text-primary",
  EXEC: "bg-positive/15 text-positive",
  RISK: "bg-warning/15 text-warning",
  VETO: "bg-negative/15 text-negative",
  WARNING: "bg-warning/15 text-warning",
  ERROR: "bg-negative/15 text-negative",
  DEBUG: "bg-muted text-muted-foreground",
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
  return (
    <Panel
      title="Event Stream"
      right={<span className="text-[10px] text-muted-foreground">{log.length} events</span>}
      className={className}
      bodyClassName="overflow-auto scroll-thin"
    >
      {log.length === 0 ? (
        <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 p-6 text-center">
          <WifiOff className="h-5 w-5 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            {engineOnline ? "No log events yet." : "Engine offline — logs stream from your local TradeBot engine."}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col">
          {log.map((e) => (
            <li key={e.id} className="flex items-start gap-2 border-b border-border/50 px-3 py-1.5 text-xs last:border-0">
              <span className="mt-0.5 w-14 shrink-0 font-mono text-[10px] tabular text-muted-foreground">{e.time}</span>
              <span
                className={cn(
                  "mt-0.5 shrink-0 rounded px-1 py-0 font-mono text-[9px] font-bold uppercase tracking-wider",
                  levelBg[e.level],
                )}
              >
                {e.level}
              </span>
              <span className="min-w-0 flex-1 leading-snug">
                {e.name && <span className="mr-1 font-mono font-semibold text-foreground/70">{e.name}</span>}
                <span className="text-foreground/80">{e.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
