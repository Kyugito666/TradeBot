"use client"

import type { LogEvent } from "@/lib/types"
import { Panel } from "./ui-kit"
import { cn } from "@/lib/utils"

const levelTone: Record<LogEvent["level"], string> = {
  INFO: "text-muted-foreground",
  SIGNAL: "text-primary",
  EXEC: "text-positive",
  RISK: "text-warning",
  VETO: "text-negative",
}
const levelBg: Record<LogEvent["level"], string> = {
  INFO: "bg-muted text-muted-foreground",
  SIGNAL: "bg-primary/15 text-primary",
  EXEC: "bg-positive/15 text-positive",
  RISK: "bg-warning/15 text-warning",
  VETO: "bg-negative/15 text-negative",
}

export function EventLog({ log }: { log: LogEvent[] }) {
  return (
    <Panel title="Event Stream" right={<span className="text-[10px] text-muted-foreground">{log.length} events</span>} bodyClassName="overflow-auto scroll-thin">
      <ul className="flex flex-col">
        {log.map((e) => (
          <li key={e.id} className="flex items-start gap-2 border-b border-border/50 px-3 py-1.5 text-xs last:border-0">
            <span className="mt-0.5 w-14 shrink-0 font-mono text-[10px] tabular text-muted-foreground">{e.time}</span>
            <span className={cn("mt-0.5 shrink-0 rounded px-1 py-0 font-mono text-[9px] font-bold uppercase tracking-wider", levelBg[e.level])}>
              {e.level}
            </span>
            <span className="min-w-0 flex-1 leading-snug">
              {e.symbol && <span className="mr-1 font-mono font-semibold text-foreground">{e.symbol.replace("USDT", "")}</span>}
              <span className={cn("text-foreground/80", e.level === "VETO" && levelTone.VETO)}>{e.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
