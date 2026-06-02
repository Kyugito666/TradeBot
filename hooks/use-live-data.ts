"use client"

import { useCallback, useMemo } from "react"
import useSWR from "swr"
import type { MarketRow, Snapshot } from "@/lib/types"
import { pollEngine, startEngine, stopEngine, type EngineSnapshot } from "@/lib/engine"
import {
  buildConsensus,
  buildPerformance,
  buildPositions,
  buildRisk,
  mapLogs,
  mapSignal,
  parseConfidence,
} from "@/lib/derive"

const EMPTY_PERF = buildPerformance([], 0)
const EMPTY_RISK = buildRisk(null, [], EMPTY_PERF)

async function marketFetcher(): Promise<{ market: MarketRow[]; ok: boolean }> {
  const res = await fetch("/api/market", { cache: "no-store" })
  if (!res.ok) return { market: [], ok: false }
  const json = await res.json()
  return { market: json.market ?? [], ok: !!json.ok }
}

export function useLiveData() {
  // Real public market data via our server route (works on localhost + Vercel).
  const market = useSWR("market", marketFetcher, {
    refreshInterval: 15000,
    keepPreviousData: true,
  })

  // Real engine state via the local/remote Go gateway.
  const engine = useSWR<EngineSnapshot>("engine", pollEngine, {
    refreshInterval: 3000,
    keepPreviousData: true,
  })

  const snapshot = useMemo<Snapshot>(() => {
    const eng = engine.data
    const rows = market.data?.market ?? []
    const marketOnline = !!market.data?.ok && rows.length > 0

    const online = !!eng?.online
    const insight = eng?.insight ?? null
    const activeSymbol = insight?.symbol ?? ""

    // Overlay the engine's real consensus signal onto the active symbol row only.
    const marketRows: MarketRow[] = rows.map((m) => {
      if (online && insight && m.symbol === activeSymbol) {
        return {
          ...m,
          signalStatus: mapSignal(insight.signal_status),
          confidence: parseConfidence(insight.advice),
        }
      }
      return m
    })

    const positions = buildPositions(eng?.active ?? [], marketRows)
    const performance = buildPerformance(eng?.history ?? [], insight?.balance ?? 0)
    const risk = buildRisk(insight, positions, performance)
    const consensus = buildConsensus(insight)
    const log = mapLogs(eng?.logs ?? [])

    return {
      mode: eng?.running ? "RUNNING" : "STOPPED",
      engineOnline: online,
      activeSymbol,
      uptimeSec: 0,
      cycle: log.length,
      latencyMs: 0,
      marketOnline,
      market: marketRows,
      consensus,
      positions,
      risk,
      performance,
      log,
    }
  }, [engine.data, market.data])

  const start = useCallback(async () => {
    try {
      await startEngine()
    } finally {
      engine.mutate()
    }
  }, [engine])

  const stop = useCallback(async () => {
    try {
      await stopEngine()
    } finally {
      engine.mutate()
    }
  }, [engine])

  const refresh = useCallback(() => {
    engine.mutate()
    market.mutate()
  }, [engine, market])

  return {
    snapshot,
    start,
    stop,
    refresh,
    loadingMarket: market.isLoading,
    loadingEngine: engine.isLoading,
  }
}

export { EMPTY_PERF, EMPTY_RISK }
