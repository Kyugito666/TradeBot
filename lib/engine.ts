import type { EngineInsight, EngineLogLine, EnginePosition } from "./types"

// Base URL of the real Go trading engine gateway (go-engine/gateway/server.go).
// Defaults to the local engine; override with NEXT_PUBLIC_ENGINE_URL to point at
// a remote/hosted engine (must be HTTPS when the dashboard is served over HTTPS).
export const ENGINE_URL = (
  process.env.NEXT_PUBLIC_ENGINE_URL || "http://localhost:8765"
).replace(/\/$/, "")

export class EngineOfflineError extends Error {
  constructor(msg = "engine offline") {
    super(msg)
    this.name = "EngineOfflineError"
  }
}

async function engineFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(ENGINE_URL + path, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers || {}) },
      // engine is a separate origin; never cache live state
      cache: "no-store",
      signal: init?.signal ?? AbortSignal.timeout(4000),
    })
  } catch {
    throw new EngineOfflineError()
  }
  if (!res.ok) throw new EngineOfflineError(`engine ${res.status}`)
  return (await res.json()) as T
}

export interface EngineStatus {
  running: boolean
}

export async function getStatus() {
  return engineFetch<EngineStatus>("/api/status")
}

export async function getInsight() {
  return engineFetch<EngineInsight>("/api/insight")
}

export async function getPositions() {
  return engineFetch<{ active: EnginePosition[]; history: EnginePosition[] }>("/api/positions")
}

export async function getLogs(since = 0) {
  return engineFetch<{ logs: EngineLogLine[]; total: number; running: boolean }>(
    `/api/logs?since=${since}`,
  )
}

export async function startEngine(cfg?: Record<string, string>) {
  return engineFetch<{ ok: boolean; message: string }>("/api/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(cfg ?? {}),
  })
}

export async function stopEngine() {
  return engineFetch<{ ok: boolean; message: string }>("/api/stop", { method: "POST" })
}

// Single combined poll the dashboard uses on every tick.
export interface EngineSnapshot {
  online: boolean
  running: boolean
  insight: EngineInsight | null
  active: EnginePosition[]
  history: EnginePosition[]
  logs: EngineLogLine[]
}

export async function pollEngine(): Promise<EngineSnapshot> {
  try {
    const [status, insight, positions, logs] = await Promise.all([
      getStatus(),
      getInsight().catch(() => null),
      getPositions().catch(() => ({ active: [], history: [] })),
      getLogs(0).catch(() => ({ logs: [], total: 0, running: false })),
    ])
    return {
      online: true,
      running: !!status.running,
      insight,
      active: positions.active ?? [],
      history: positions.history ?? [],
      logs: logs.logs ?? [],
    }
  } catch {
    return { online: false, running: false, insight: null, active: [], history: [], logs: [] }
  }
}
