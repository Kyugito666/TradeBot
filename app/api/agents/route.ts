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

export async function GET() {
  const ts = Date.now()
  try {
    const res = await fetch("http://127.0.0.1:8080/api/state", { cache: "no-store" })
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`)
    const state = await res.json() as EvolutionState
    const body: AgentsResponse = { ok: true, ts, state }
    return NextResponse.json(body)
  } catch (err) {
    const body: AgentsResponse = {
      ok: false,
      ts,
      state: null,
      error: err instanceof Error ? err.message : String(err),
    }
    return NextResponse.json(body)
  }
}
