"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { MarketRow } from "@/lib/types"
import { localStore, type SignalForwardState } from "@/lib/local-store"
import {
  buildCandidates,
  closeTradeManual,
  computeStats,
  evaluateTrade,
  type PaperTrade,
  type SignalCandidate,
} from "@/lib/signal-engine"
import type { AgentAnalysisResponse, CexConfig, RiskModel, TradingStyle } from "@/hooks/use-live-data"



interface Params {
  market: MarketRow[]
  marketOnline: boolean
  style: TradingStyle
  risk: RiskModel
  activeCex: CexConfig | undefined
  agentAnalysis?: AgentAnalysisResponse | null
  paperBalance: number
}

// Send TP/SL outcome back to the agent self-evaluation framework so the team can
// learn from paper results. Fire-and-forget; failures never affect the UI.
function reportTradeForLearning(trade: PaperTrade) {
  const isWin = (trade.pnlR ?? 0) > 0
  fetch("/api/agents/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      symbol: trade.symbol,
      direction: trade.side,
      pnlR: trade.pnlR ?? 0,
      isWin,
      agentVotes: trade.agentVotes ?? [],
    }),
  }).catch(() => {})
}

export function useSignalTrades({ market, marketOnline, style, risk, activeCex, agentAnalysis, paperBalance }: Params) {
  const [state, setState] = useState<SignalForwardState>({
    autoEntry: false,
    autoTpSl: true,
    open: [],
    history: [],
  })
  const [hydrated, setHydrated] = useState(false)

  // Hydrate open trades from localStorage after mount.
  // History is fetched from the persistent SQLite database.
  useEffect(() => {
    const local = localStore.loadSignalState()
    setState((prev) => ({ ...prev, open: local.open, autoEntry: local.autoEntry, autoTpSl: local.autoTpSl }))
    setHydrated(true)

    fetch("/api/history/paper")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setState((prev) => ({ ...prev, history: data }))
        }
      })
      .catch((err) => console.error("Failed to load paper history from DB", err))
  }, [])

  // Persist open trades whenever state changes post-hydration.
  useEffect(() => {
    if (hydrated) {
      // We only save open trades and settings to local storage. 
      // History is persisted to DB immediately when closed.
      localStore.saveSignalState({ ...state, history: [] })
    }
  }, [hydrated, state.open, state.autoEntry, state.autoTpSl])

  // Always-on filtered candidate list derived from the live market scan + Settings.
  const candidates: SignalCandidate[] = buildCandidates(market, style, risk, activeCex)

  // Keep the latest candidates/settings in a ref so the forward-test effect can
  // read them without re-subscribing on every tick.
  const candidatesRef = useRef(candidates)
  candidatesRef.current = candidates
  const agentRef = useRef(agentAnalysis)
  agentRef.current = agentAnalysis

  // ── Forward-test loop: runs on every live market tick ──────────────────────
  useEffect(() => {
    if (!hydrated || !marketOnline || market.length === 0) return
    const priceBySymbol = new Map(market.map((m) => [m.symbol, m.lastPrice]))

    setState((prev) => {
      let changed = false
      const stillOpen: PaperTrade[] = []
      const newlyClosed: PaperTrade[] = []

      // 1) Process open trades: check PENDING fills, then evaluate TP/SL for FILLED trades.
      for (const trade of prev.open) {
        const mark = priceBySymbol.get(trade.symbol)
        if (mark === undefined || mark <= 0) {
          stillOpen.push(trade)
          continue
        }

        // Update live price on all trades (for UI display)
        const withLivePrice = { ...trade, livePrice: mark }

        // Check PENDING → FILLED transition (limit order fill)
        if (trade.status === "PENDING" || !trade.status) {
          const isFilled =
            trade.side === "LONG"
              ? mark <= trade.entry  // Long limit: price drops to entry
              : mark >= trade.entry  // Short limit: price rises to entry

          if (isFilled) {
            // Limit order filled!
            withLivePrice.status = "FILLED"
            changed = true
            stillOpen.push(withLivePrice)
          } else {
            // Still pending — PnL stays 0, just track live price
            withLivePrice.status = "PENDING"
            stillOpen.push(withLivePrice)
            // Mark changed so livePrice updates in UI
            if (trade.livePrice !== mark) changed = true
          }
          continue
        }

        // FILLED trades: evaluate TP/SL hits
        if (prev.autoTpSl && trade.status === "FILLED") {
          const closed = evaluateTrade(trade, mark)
          if (closed) {
            newlyClosed.push({ ...closed, status: "CLOSED" })
            changed = true
            continue
          }
        }

        // Still open — update live price
        if (trade.livePrice !== mark) changed = true
        stillOpen.push(withLivePrice)
      }

      // 2) Auto-entry: open paper trades for qualifying signals not already open, constrained by margin.
      if (prev.autoEntry) {
        // Calculate true live equity based on historical PnL
        let totalRealizedPnl = 0
        for (const t of prev.history) {
          totalRealizedPnl += (t.margin || 0) * ((t.pnlPct || 0) / 100)
        }
        for (const t of newlyClosed) {
          totalRealizedPnl += (t.margin || 0) * ((t.pnlPct || 0) / 100)
        }
        const liveEquity = Math.max(1, paperBalance + totalRealizedPnl)

        const marginLimitPct = activeCex?.marginUsagePct ?? 10
        const maxMarginUsd = liveEquity * (marginLimitPct / 100)
        let currentMarginUsd = 0
        
        // Calculate absolute margin already used by open trades.
        for (const t of stillOpen) {
          const slPct = Math.abs(t.entry - t.sl) / t.entry
          const riskUsd = liveEquity * (risk.maxPnlPct / 100)
          const positionSize = riskUsd / slPct
          const marginUsed = t.margin || Math.max(0.1, positionSize / t.leverage)
          currentMarginUsd += marginUsed
        }

        const openSymbols = new Set(stillOpen.map((t) => t.symbol))
        for (const c of candidatesRef.current) {
          if (openSymbols.has(c.row.symbol)) continue
          
          // Extra safety net: Auto-Entry is exclusively for highly confident setups (>= 0.7)
          if (c.row.confidence < 0.7) continue
          
          const slPct = Math.abs(c.levels.entry - c.levels.sl) / c.levels.entry
          const riskUsd = liveEquity * (risk.maxPnlPct / 100)
          const positionSize = riskUsd / slPct
          const requiredMarginUsd = Math.max(0.1, positionSize / c.levels.leverage)
          
          if (currentMarginUsd + requiredMarginUsd > maxMarginUsd) {
            // Margin limit reached, cannot open more trades automatically
            break
          }
          
          currentMarginUsd += requiredMarginUsd // DEDUCT MARGIN
          
          const votes =
            agentRef.current?.symbol === c.row.symbol
              ? agentRef.current.agentOutputs?.map((o) => ({
                  agentId: o.agentId,
                  vote: o.vote,
                  confidence: o.confidence,
                }))
              : undefined

          if (votes?.some(v => v.vote === "VETO" || v.vote === "WAIT")) {
            continue // Veto functionality: Block auto-entry!
          }

          stillOpen.push({
            id: `${c.row.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            symbol: c.row.symbol,
            side: c.levels.side,
            entry: c.levels.entry,
            tp: c.levels.tp,
            sl: c.levels.sl,
            leverage: c.levels.leverage,
            confidence: c.row.confidence,
            margin: requiredMarginUsd,
            openedAt: Date.now(),
            status: "PENDING",
            reason: `LIMIT ${c.levels.side} · conf ${(c.row.confidence * 100).toFixed(0)}% · RR 1:${c.levels.riskReward}`,
            agentVotes: votes,
          })
          openSymbols.add(c.row.symbol)
          changed = true
        }
      }

      if (!changed) return prev

      // Feed closed trades back to the agents for self-improvement AND persist to DB.
      for (const t of newlyClosed) {
        reportTradeForLearning(t)
        fetch("/api/history/paper", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(t),
        }).catch(() => {})
      }

      return {
        ...prev,
        open: stillOpen,
        history: [...newlyClosed, ...prev.history].slice(0, 100),
      }
    })
  }, [hydrated, marketOnline, market])

  // ── Manual controls ────────────────────────────────────────────────────────
  const toggleAutoEntry = useCallback(() => {
    setState((prev) => ({ ...prev, autoEntry: !prev.autoEntry }))
  }, [])

  const toggleAutoTpSl = useCallback(() => {
    setState((prev) => ({ ...prev, autoTpSl: !prev.autoTpSl }))
  }, [])

  // Manually open a paper trade from a specific candidate (one per symbol).
  const openTrade = useCallback(
    (candidate: SignalCandidate) => {
      setState((prev) => {
        if (prev.open.some((t) => t.symbol === candidate.row.symbol)) return prev
        const votes =
          agentRef.current?.symbol === candidate.row.symbol
            ? agentRef.current.agentOutputs?.map((o) => ({
                agentId: o.agentId,
                vote: o.vote,
                confidence: o.confidence,
              }))
            : undefined
        const trade: PaperTrade = {
          id: `${candidate.row.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          symbol: candidate.row.symbol,
          side: candidate.levels.side,
          entry: candidate.levels.entry,
          tp: candidate.levels.tp,
          sl: candidate.levels.sl,
          leverage: candidate.levels.leverage,
          confidence: candidate.row.confidence,
          margin: Math.max(1, (paperBalance * (risk.maxPnlPct / 100)) / (Math.abs(candidate.levels.entry - candidate.levels.sl) / candidate.levels.entry) / candidate.levels.leverage),
          openedAt: Date.now(),
          status: "PENDING",
          reason: `LIMIT ${candidate.levels.side} · conf ${(candidate.row.confidence * 100).toFixed(0)}%`,
          agentVotes: votes,
        }
        return { ...prev, open: [...prev.open, trade] }
      })
    },
    [],
  )

  const closeTrade = useCallback((id: string) => {
    setState((prev) => {
      const t = prev.open.find((x) => x.id === id)
      if (!t) return prev
      const mark = candidatesRef.current.find((c) => c.row.symbol === t.symbol)?.row.lastPrice || t.entry
      
      const closed = { ...t, exitPrice: mark, outcome: "MANUAL" as const, closedAt: Date.now() }
      const pnlPct = ((mark - t.entry) / t.entry) * (t.side === "LONG" ? 1 : -1) * t.leverage * 100
      closed.pnlPct = pnlPct
      closed.pnlR = pnlPct / t.leverage // Approximate R
      
      // Save to DB immediately
      fetch("/api/history/paper", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(closed),
      }).catch(() => {})
      reportTradeForLearning(closed)

      return {
        ...prev,
        open: prev.open.filter((x) => x.id !== id),
        history: [closed, ...prev.history],
      }
    })
  }, [])

  const closeAllTrades = useCallback(() => {
    setState((prev) => {
      const closedTrades = prev.open.map((t) => {
        const mark = candidatesRef.current.find((c) => c.row.symbol === t.symbol)?.row.lastPrice || t.entry
        const closed = { ...t, exitPrice: mark, outcome: "MANUAL" as const, closedAt: Date.now() }
        const pnlPct = ((mark - t.entry) / t.entry) * (t.side === "LONG" ? 1 : -1) * t.leverage * 100
        closed.pnlPct = pnlPct
        closed.pnlR = pnlPct / t.leverage
        
        fetch("/api/history/paper", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(closed),
        }).catch(() => {})
        reportTradeForLearning(closed)
        return closed
      })
      
      return {
        ...prev,
        open: [],
        history: [...closedTrades, ...prev.history],
      }
    })
  }, [])

  const clearHistory = useCallback(() => {
    setState((prev) => ({ ...prev, history: [] }))
    // Does not delete from DB, just clears the UI! (Persistent History)
  }, [])

  const stats = computeStats(state.history)

  return {
    hydrated,
    candidates,
    open: state.open,
    history: state.history,
    autoEntry: state.autoEntry,
    autoTpSl: state.autoTpSl,
    stats,
    toggleAutoEntry,
    toggleAutoTpSl,
    openTrade,
    closeTrade,
    closeAllTrades,
    clearHistory,
  }
}
