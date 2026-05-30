"use client"

import { useState } from "react"
import {
  BarChart3,
  Bot,
  Boxes,
  GaugeCircle,
  LayoutDashboard,
  Radar,
  ScrollText,
  Settings,
  ShieldHalf,
} from "lucide-react"
import { cn } from "@/lib/utils"

const ITEMS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "signals", label: "Signals", icon: Radar },
  { id: "consensus", label: "Consensus", icon: Bot },
  { id: "positions", label: "Positions", icon: Boxes },
  { id: "risk", label: "Risk", icon: ShieldHalf },
  { id: "performance", label: "Performance", icon: BarChart3 },
  { id: "logs", label: "Logs", icon: ScrollText },
]

export function NavRail() {
  const [active, setActive] = useState("overview")
  return (
    <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-panel py-3">
      <div className="mb-2 flex h-8 w-8 items-center justify-center rounded bg-primary/15 text-primary">
        <GaugeCircle className="h-4.5 w-4.5" strokeWidth={2.2} />
      </div>
      {ITEMS.map((it) => {
        const Icon = it.icon
        const isActive = active === it.id
        return (
          <button
            key={it.id}
            onClick={() => setActive(it.id)}
            title={it.label}
            aria-label={it.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group relative flex h-10 w-10 items-center justify-center rounded-md transition-colors",
              isActive ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {isActive && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />}
            <Icon className="h-[18px] w-[18px]" />
          </button>
        )
      })}
      <button
        title="Settings"
        aria-label="Settings"
        className="mt-auto flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Settings className="h-[18px] w-[18px]" />
      </button>
    </nav>
  )
}
