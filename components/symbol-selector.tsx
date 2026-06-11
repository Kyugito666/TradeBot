"use client"

import React, { useState, useMemo, useRef, useEffect } from "react"
import { Search, Play, ChevronDown } from "lucide-react"
import { MarketRow } from "@/lib/types"
import { PairStat } from "@/lib/backtest-engine"
import { cn } from "@/lib/utils"

export function SymbolSelector({
  market,
  pairStats,
  analysisSymbol,
  isAnalyzing,
  runAnalysis,
}: {
  market: MarketRow[]
  pairStats: Record<string, PairStat>
  analysisSymbol: string
  isAnalyzing: boolean
  runAnalysis: (sym: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  // Top pairs (hot/recommended) vs All pairs
  const sortedPairs = useMemo(() => {
    const syms = market.map((m) => m.symbol)
    return [...syms].sort((a, b) => {
      return (pairStats[b]?.expectancyR ?? Number.NEGATIVE_INFINITY) - (pairStats[a]?.expectancyR ?? Number.NEGATIVE_INFINITY)
    })
  }, [market, pairStats])

  const filtered = useMemo(() => {
    if (!search) return sortedPairs
    return sortedPairs.filter((s) => s.toLowerCase().includes(search.toLowerCase()))
  }, [search, sortedPairs])

  return (
    <div className="relative w-full" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        disabled={isAnalyzing}
        className="flex w-full items-center justify-between gap-2 rounded border border-border bg-background px-3 py-2 text-sm font-mono text-foreground transition-colors hover:border-primary/50 disabled:opacity-50"
      >
        <span className="flex items-center gap-2">
          {isAnalyzing ? (
            <Play className="h-4 w-4 animate-pulse text-primary fill-primary" />
          ) : (
            <Search className="h-4 w-4 text-muted-foreground" />
          )}
          {analysisSymbol ? analysisSymbol.replace("USDT", " / USDT") : "Select pair..."}
        </span>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute top-full z-50 mt-1 w-full overflow-hidden rounded border border-border bg-panel shadow-2xl">
          <div className="flex items-center gap-2 border-b border-border p-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              autoFocus
              placeholder="Search pair..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-transparent text-sm font-mono text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto p-1 scroll-thin">
            {filtered.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">No pairs found</div>
            ) : (
              filtered.map((sym) => {
                const stat = pairStats[sym]
                const isSelected = sym === analysisSymbol
                return (
                  <button
                    key={sym}
                    onClick={() => {
                      runAnalysis(sym)
                      setOpen(false)
                      setSearch("")
                    }}
                    className={cn(
                      "flex w-full items-center justify-between rounded px-3 py-2 text-left font-mono text-xs transition-colors",
                      isSelected ? "bg-primary/15 text-primary font-bold" : "hover:bg-muted/50 text-foreground"
                    )}
                  >
                    <span>{sym.replace("USDT", "")}<span className="text-muted-foreground">/USDT</span></span>
                    {stat && (
                      <span className={cn("text-[10px]", stat.expectancyR >= 0 ? "text-positive" : "text-negative")}>
                        WR {stat.winRate.toFixed(0)}%
                      </span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
