"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { BotMode, Snapshot } from "@/lib/types"
import { buildSnapshot, nextTick } from "@/lib/mock-data"

export function useLiveData(intervalMs = 2000) {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => buildSnapshot(42, "RUNNING"))
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const tick = useCallback(() => {
    setSnapshot((prev) => (prev.mode === "RUNNING" ? nextTick(prev) : prev))
  }, [])

  useEffect(() => {
    timer.current = setInterval(tick, intervalMs)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [tick, intervalMs])

  const setMode = useCallback((mode: BotMode) => {
    setSnapshot((prev) => ({ ...prev, mode }))
  }, [])

  const toggleKillSwitch = useCallback(() => {
    setSnapshot((prev) => ({
      ...prev,
      risk: { ...prev.risk, killSwitchArmed: !prev.risk.killSwitchArmed },
    }))
  }, [])

  return { snapshot, setMode, toggleKillSwitch }
}
