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

// Cap concurrent auto-opened paper positions so the forward-test stays readable.
const MAX_OPEN = 6

interface Params {
  market: MarketRow[]
  marketOnline: boolean
  style: TradingStyle
  risk: RiskModel
  activeCex: CexConfig | undefined
  agentAnalysis?: AgentAnalysisResponse | null
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

export function useSignalTrades({ market, marketOnline, style, risk, activeCex, agentAnalysis }: Params) {
  const [state, setState] = useState<SignalForwardState>({
    autoEntry: false,
    autoTpSl: true,
    open: [],
    history: [],
  })
  const [hydrated, setHydrated] = useState(false)

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    setState(localStore.loadSignalState())
    setHydrated(true)
  }, [])

  // Persist whenever state changes post-hydration.
  useEffect(() => {
    if (hydrated) localStore.saveSignalState(state)
  }, [hydrated, state])

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

      // 1) Evaluate open trades for TP/SL hits (only when auto TP/SL is on).
      for (const trade of prev.open) {
        const mark = priceBySymbol.get(trade.symbol)
        if (prev.autoTpSl && mark !== undefined) {
          const closed = evaluateTrade(trade, mark)
          if (closed) {
            newlyClosed.push(closed)
            changed = true
            continue
          }
        }
        stillOpen.push(trade)
      }

      // 2) Auto-entry: open paper trades for qualifying signals not already open.
      if (prev.autoEntry && stillOpen.length < MAX_OPEN) {
        const openSymbols = new Set(stillOpen.map((t) => t.symbol))
        for (const c of candidatesRef.current) {
          if (stillOpen.length >= MAX_OPEN) break
          if (openSymbols.has(c.row.symbol)) continue
          const votes =
            agentRef.current?.symbol === c.row.symbol
              ? agentRef.current.agentOutputs?.map((o) => ({
                  agentId: o.agentId,
                  vote: o.vote,
                  confidence: o.confidence,
                }))
              : undefined
          stillOpen.push({
            id: `${c.row.symbol}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            symbol: c.row.symbol,
            side: c.levels.side,
            entry: c.levels.entry,
            tp: c.levels.tp,
            sl: c.levels.sl,
            leverage: c.levels.leverage,
            confidence: c.row.confidence,
            openedAt: Date.now(),
            reason: `${c.levels.side} setup · conf ${(c.row.confidence * 100).toFixed(0)}% · RR 1:${c.levels.riskReward}`,
            agentVotes: votes,
          })
          openSymbols.add(c.row.symbol)
          changed = true
        }
      }

      if (!changed) return prev

      // Feed closed trades back to the agents for self-improvement.
      for (const t of newlyClosed) reportTradeForLearning(t)

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
          openedAt: Date.now(),
          reason: `Manual ${candidate.levels.side} · conf ${(candidate.row.confidence * 100).toFixed(0)}%`,
          agentVotes: votes,
        }
        return { ...prev, open: [...prev.open, trade] }
      })
    },
    [],
  )

  // Manually close an open trade at the latest mark price.
  const closeTrade = useCallback(
    (id: string) => {
      const mark = market.find((m) => state.open.some((t) => t.id === id && t.symbol === m.symbol))?.lastPrice
      setState((prev) => {
        const trade = prev.open.find((t) => t.id === id)
        if (!trade) return prev
        const px = mark ?? trade.entry
        const closed = closeTradeManual(trade, px)
        reportTradeForLearning(closed)
        return {
          ...prev,
          open: prev.open.filter((t) => t.id !== id),
          history: [closed, ...prev.history].slice(0, 100),
        }
      })
    },
    [market, state.open],
  )

  const clearHistory = useCallback(() => {
    setState((prev) => ({ ...prev, history: [] }))
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
    clearHistory,
  }
}
