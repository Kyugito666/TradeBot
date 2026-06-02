import { NextResponse } from "next/server"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { AgentsResponse, EvolutionState } from "@/lib/types"

// Reads the live self-evaluation state written by the Rust brain
// (rust-brain/src/evolution/mod.rs -> agent_evolution.json). The bot writes this
// file to the project root on every closed trade, so when you run the stack
// locally (./start_bot.sh) this endpoint reflects the latest agent evolution.
//
// AGENT_EVOLUTION_FILE lets you point at the file explicitly if your working
// directory differs.

export const dynamic = "force-dynamic"
export const revalidate = 0

function candidatePaths(): string[] {
  const override = process.env.AGENT_EVOLUTION_FILE
  const root = process.cwd()
  const paths = [
    override,
    path.join(root, "agent_evolution.json"),
    path.join(root, "..", "agent_evolution.json"),
  ].filter(Boolean) as string[]
  return paths
}

export async function GET() {
  const ts = Date.now()
  let lastErr = "agent_evolution.json not found"

  for (const p of candidatePaths()) {
    try {
      const raw = await readFile(p, "utf8")
      const state = JSON.parse(raw) as EvolutionState
      const body: AgentsResponse = { ok: true, ts, state }
      return NextResponse.json(body)
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
    }
  }

  const body: AgentsResponse = {
    ok: false,
    ts,
    state: null,
    error: lastErr,
  }
  // 200 so the dashboard can render an informative empty state without throwing.
  return NextResponse.json(body)
}
