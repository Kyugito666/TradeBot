"use client"

import { useCallback, useEffect, useState } from "react"
import type { MarketRow, PaperTrade, SignalCandidate } from "@/lib/types"
import type { AgentAnalysisResponse, CexConfig, RiskModel, TradingStyle } from "@/hooks/use-live-data"

interface Params {
  market: MarketRow[]
  marketOnline: boolean
  style: TradingStyle
  risk: RiskModel
  activeCex: CexConfig | undefined
  agentAnalysis?: AgentAnalysisResponse | null
}

export function useSignalTrades({ market, marketOnline, style, risk, activeCex, agentAnalysis }: Params) {
  const [candidates, setCandidates] = useState<SignalCandidate[]>([])
  const [open, setOpen] = useState<PaperTrade[]>([])
  const [history, setHistory] = useState<PaperTrade[]>([])
  const [autoEntry, setAutoEntry] = useState(false)
  const [autoTpSl, setAutoTpSl] = useState(true)

  // Fetch state dari backend Go Engine via proxy
  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/agents")
        if (res.ok) {
           const data = await res.json()
           // Di sini data dari backend akan diproses.
           // Kalkulasi lokal dihapus. Go Engine mengatur state.
        }
      } catch (err) {}
    }
    const timer = setInterval(fetchData, 5000)
    fetchData()
    return () => clearInterval(timer)
  }, [])

  const toggleAutoEntry = useCallback(() => setAutoEntry(prev => !prev), [])
  const toggleAutoTpSl = useCallback(() => setAutoTpSl(prev => !prev), [])
  
  const openTrade = useCallback(async (candidate: SignalCandidate) => {
    // Teruskan ke backend di produksi
  }, [])
  
  const closeTrade = useCallback(async (id: string) => {
    // Teruskan ke backend di produksi
  }, [])

  const clearHistory = useCallback(() => setHistory([]), [])

  const stats = {
    total: history.length,
    wins: history.filter(t => (t.pnlR ?? 0) > 0).length,
    losses: history.filter(t => (t.pnlR ?? 0) < 0).length,
    winRate: 0,
    netR: 0,
    netRoiPct: 0,
    avgR: 0,
  }

  return {
    hydrated: true,
    candidates,
    open,
    history,
    autoEntry,
    autoTpSl,
    stats,
    toggleAutoEntry,
    toggleAutoTpSl,
    openTrade,
    closeTrade,
    clearHistory,
  }
}
