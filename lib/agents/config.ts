// ────────────────────────────────────────────────────────────────────────────────
// AGENT TEAM CONFIG — Single source of truth for the analysis team.
//
// This mirrors the `WEIGHTS` table in rust-brain/src/consensus/mod.rs. Every agent
// the team should run is listed here with its initial weight and an `enabled` flag.
//
// WHERE DO ACTIVE AGENTS COME FROM?
//   1. This file declares the roster (13 agents) + initial weights + enable flags.
//   2. `builtin-agents.ts` registers each implementation into the registry ONLY if
//      its config entry is `enabled`.
//   3. The pipeline runs `registry.getEnabledAgents()` — so the executed count is
//      driven entirely by the `enabled` flags below.
//
// ADDING A NEW AGENT (no architecture change required):
//   1. Add an entry here (id, name, category, weight, enabled).
//   2. Implement it in `builtin-agents.ts` and map it in AGENT_BUILDERS.
//   That's it — the registry, pipeline, progress count and self-evaluation all
//   pick it up automatically.
// ────────────────────────────────────────────────────────────────────────────────

import type { AgentCategory } from "./types"

export interface AgentConfigEntry {
  id: string
  name: string
  category: AgentCategory
  weight: number
  enabled: boolean
}

// 13-agent quant team. Weights mirror the Rust consensus `WEIGHTS` constant.
// `data_engineer` is a gatekeeper (weight 0) — it only vetoes bad data.
export const AGENT_TEAM_CONFIG: AgentConfigEntry[] = [
  { id: "mathematician",  name: "Mathematician",   category: "quant",      weight: 0.25, enabled: true },
  { id: "physicist",      name: "Physicist",       category: "risk",       weight: 0.20, enabled: true },
  { id: "cryptographer",  name: "Cryptographer",   category: "orderflow",  weight: 0.15, enabled: true },
  { id: "linguist",       name: "Linguist",        category: "sentiment",  weight: 0.10, enabled: true },
  { id: "liquidator",     name: "Liquidator",      category: "orderflow",  weight: 0.10, enabled: true },
  { id: "absurdist",      name: "Absurdist",       category: "onchain",    weight: 0.10, enabled: true },
  { id: "game_theorist",  name: "Game Theorist",   category: "orderflow",  weight: 0.15, enabled: true },
  { id: "economist",      name: "Economist",       category: "macro",      weight: 0.15, enabled: true },
  { id: "data_engineer",  name: "Data Engineer",   category: "gatekeeper", weight: 0.0,  enabled: true },
  { id: "data_scientist", name: "Data Scientist",  category: "quant",      weight: 0.15, enabled: true },
  { id: "statistician",   name: "Statistician",    category: "macro",      weight: 0.15, enabled: true },
  { id: "psychologist",   name: "Psychologist",    category: "sentiment",  weight: 0.10, enabled: true },
  { id: "astrophysicist", name: "Astrophysicist",  category: "onchain",    weight: 0.15, enabled: true },
]

// Number of agents the team SHOULD run when fully configured. Used by the pipeline
// guard to warn (never fail) on a registry/config mismatch.
export const EXPECTED_AGENT_COUNT = AGENT_TEAM_CONFIG.filter((a) => a.enabled).length

export function getAgentConfig(id: string): AgentConfigEntry | undefined {
  return AGENT_TEAM_CONFIG.find((a) => a.id === id)
}
