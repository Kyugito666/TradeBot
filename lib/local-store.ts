// Local-first "database": all per-user data lives in the browser's localStorage.
// No backend, no env vars — works identically on localhost and when deployed to
// Vercel. Each browser profile is effectively its own isolated user.

import type { DryRunConfig, TradingSettings } from "@/hooks/use-live-data"
import type { BacktestResult } from "./backtest"
import type { PaperTrade } from "./signal-engine"

const PREFIX = "tradebot:v1:"
const KEYS = {
  settings: `${PREFIX}trading-settings`,
  dryRun: `${PREFIX}dry-run`,
  backtests: `${PREFIX}backtests`,
  signalState: `${PREFIX}signal-forwardtest`,
} as const

// Persisted state for the Signal tab forward-test (paper-only, never real).
export interface SignalForwardState {
  autoEntry: boolean
  autoTpSl: boolean
  open: PaperTrade[]
  history: PaperTrade[]
}

const DEFAULT_SIGNAL_STATE: SignalForwardState = {
  autoEntry: false,
  autoTpSl: true,
  open: [],
  history: [],
}

function isBrowser() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function read<T>(key: string): T | null {
  if (!isBrowser()) return null
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function write<T>(key: string, value: T) {
  if (!isBrowser()) return
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore quota / serialization errors
  }
}

export const localStore = {
  loadTradingSettings: () => read<TradingSettings>(KEYS.settings),
  saveTradingSettings: (s: TradingSettings) => write(KEYS.settings, s),

  loadDryRun: () => read<DryRunConfig>(KEYS.dryRun),
  saveDryRun: (c: DryRunConfig) => write(KEYS.dryRun, c),

  loadBacktests: () => read<BacktestResult[]>(KEYS.backtests) ?? [],
  saveBacktests: (results: BacktestResult[]) => write(KEYS.backtests, results),
  clearBacktests: () => write(KEYS.backtests, []),

  loadSignalState: (): SignalForwardState => ({
    ...DEFAULT_SIGNAL_STATE,
    ...(read<SignalForwardState>(KEYS.signalState) ?? {}),
  }),
  saveSignalState: (s: SignalForwardState) => write(KEYS.signalState, s),
}
