// ────────────────────────────────────────────────────────────────────────────────
// Analysis Pipeline — runs the full 13-agent team with robust progress tracking.
//
// CRITICAL GUARANTEES (fixes the "stuck at 2/3 / FAILED" issue):
//   • Every agent runs inside try/catch + timeout — one failing agent NEVER aborts
//     the run; it degrades to a WAIT vote and the pipeline keeps going.
//   • A registry/config mismatch (e.g. fewer agents than expected) only logs a
//     warning — it never throws and never stops the pipeline.
//   • The pipeline always advances through all 6 stages to `complete` (or returns a
//     well-formed `error` result), so progress never freezes mid-way.
// ────────────────────────────────────────────────────────────────────────────────

import { agentRegistry } from "./registry"
import { registerBuiltinAgents } from "./builtin-agents"
import { EXPECTED_AGENT_COUNT } from "./config"
import type {
  AgentInput,
  AgentOutput,
  AgentVote,
  PipelineProgress,
  PipelineStage,
  TeamConsensus,
  IAgent,
} from "./types"

// Ensure agents are registered (idempotent — register() replaces duplicates).
let initialized = false
function ensureInitialized() {
  if (!initialized) {
    registerBuiltinAgents()
    initialized = true
  }
}

export interface PipelineResult {
  consensus: TeamConsensus
  agentOutputs: AgentOutput[]
  progress: PipelineProgress
  executedAgents: number
  expectedAgents: number
  warnings: string[]
  error?: string
}

type ProgressCallback = (progress: PipelineProgress) => void

// Mirror of the Rust scalping StyleConfig defaults (consensus/mod.rs).
const STYLE = {
  minConfidence: 0.2,
  minAgree: 1,
  noiseVeto: 1.5,
  tpAtrMult: 1.2,
  slAtrMult: 1.0,
}

const ABSURDIST_DAMP = 0.3
const LINGUIST_DAMP = 0.5

export async function runAnalysisPipeline(
  input: AgentInput,
  onProgress?: ProgressCallback,
): Promise<PipelineResult> {
  ensureInitialized()

  const agents = agentRegistry.getEnabledAgents()
  const totalSteps = 6
  const startTime = Date.now()
  const warnings: string[] = []

  // ── GUARD: agent count mismatch is a warning, never a failure ──────────────
  if (agents.length !== EXPECTED_AGENT_COUNT) {
    const w = `Agent roster mismatch: ${agents.length} registered vs ${EXPECTED_AGENT_COUNT} expected (config). Running with available agents.`
    console.warn(`[Pipeline] ${w}`)
    warnings.push(w)
  }
  if (agents.length === 0) {
    // Re-register defensively so we never run with an empty team.
    registerBuiltinAgents()
  }

  const liveAgents = agentRegistry.getEnabledAgents()

  const updateProgress = (stage: PipelineStage, step: number, message: string, agentsComplete = 0): PipelineProgress => {
    const progress: PipelineProgress = {
      stage,
      currentStep: step,
      totalSteps,
      agentsCompleted: agentsComplete,
      totalAgents: liveAgents.length,
      message,
      startedAt: startTime,
    }
    onProgress?.(progress)
    return progress
  }

  let lastProgress: PipelineProgress = updateProgress("idle", 0, "Initializing")

  try {
    // STAGE 1 — validate input
    lastProgress = updateProgress("fetching_data", 1, "Validating market data...")
    if (!input.closes?.length) throw new Error("No price data available")

    // STAGE 2 — run all agents (each isolated; failures degrade to WAIT)
    lastProgress = updateProgress("running_agents", 2, `Running ${liveAgents.length} agents...`)
    const agentOutputs: AgentOutput[] = []
    for (let i = 0; i < liveAgents.length; i++) {
      const agent = liveAgents[i]
      lastProgress = updateProgress("running_agents", 2, `Agent ${i + 1}/${liveAgents.length}: ${agent.name}`, i)
      agentOutputs.push(await runAgentSafely(agent, input))
    }
    lastProgress = updateProgress("running_agents", 2, `All ${liveAgents.length} agents completed`, liveAgents.length)

    // STAGE 3 — aggregate weighted votes (Rust-style score normalization)
    lastProgress = updateProgress("aggregating_votes", 3, "Aggregating weighted agent votes...")
    const effectiveWeights = calcEffectiveWeights(liveAgents, agentOutputs, input)

    // STAGE 4 — risk / veto check (data_engineer, physicist, mathematician)
    lastProgress = updateProgress("risk_check", 4, "Performing risk & veto assessment...")
    const veto = detectVeto(agentOutputs)

    // STAGE 5 — generate consensus signal
    lastProgress = updateProgress("generating_signal", 5, "Generating consensus signal...")
    const consensus = buildConsensus(agentOutputs, effectiveWeights, veto, input)

    // STAGE 6 — complete
    lastProgress = updateProgress("complete", 6, `Analysis complete — ${liveAgents.length} agents, signal ${consensus.signal}`)
    lastProgress.completedAt = Date.now()

    return {
      consensus,
      agentOutputs,
      progress: lastProgress,
      executedAgents: agentOutputs.length,
      expectedAgents: EXPECTED_AGENT_COUNT,
      warnings,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown pipeline error"
    console.error("[Pipeline] Error:", errorMsg)
    lastProgress = updateProgress("error", lastProgress?.currentStep ?? 0, `Error: ${errorMsg}`)
    lastProgress.error = errorMsg
    return {
      consensus: emptyConsensus(`Pipeline error: ${errorMsg}`, input.price),
      agentOutputs: [],
      progress: lastProgress,
      executedAgents: 0,
      expectedAgents: EXPECTED_AGENT_COUNT,
      warnings,
      error: errorMsg,
    }
  }
}

// Run one agent with a hard timeout; any error becomes a WAIT vote (never throws).
async function runAgentSafely(agent: IAgent, input: AgentInput): Promise<AgentOutput> {
  try {
    return await Promise.race([
      agent.analyze(input),
      new Promise<AgentOutput>((_, reject) => setTimeout(() => reject(new Error("Agent timeout")), 5000)),
    ])
  } catch (err) {
    console.error(`[Pipeline] Agent ${agent.id} failed:`, err)
    return {
      agentId: agent.id,
      vote: "WAIT",
      confidence: 0,
      reasoning: `Agent error: ${err instanceof Error ? err.message : "Unknown"}`,
      metrics: {},
    }
  }
}

// ── Effective weights: base config weight × adaptive damping (Rust calc_effective_weights) ──
function calcEffectiveWeights(
  agents: IAgent[],
  outputs: AgentOutput[],
  input: AgentInput,
): Map<string, number> {
  const ew = new Map<string, number>()
  for (const a of agents) ew.set(a.id, a.weight)

  // Absurdist conflicting with EMA trend → damp
  const ema9 = ema(input.closes, 9)
  const ema21 = ema(input.closes, 21)
  const ema50 = ema(input.closes, 50)
  const emaBull = ema9 > ema21 && ema21 > ema50
  const emaBear = ema9 < ema21 && ema21 < ema50

  const absurd = outputs.find((o) => o.agentId === "absurdist")
  if (absurd && ew.has("absurdist")) {
    const conflicts = (emaBear && absurd.vote === "LONG") || (emaBull && absurd.vote === "SHORT")
    if (conflicts) ew.set("absurdist", ew.get("absurdist")! * ABSURDIST_DAMP)
  }
  if (ew.has("linguist") && input.newsCount < 3) {
    ew.set("linguist", ew.get("linguist")! * LINGUIST_DAMP)
  }
  return ew
}

interface VetoInfo {
  vetoed: boolean
  reason: string
  agents: string[]
}

// Mirror of Rust ConsensusEngine::check_veto.
function detectVeto(outputs: AgentOutput[]): VetoInfo {
  const agents: string[] = []
  let reason = ""

  const de = outputs.find((o) => o.agentId === "data_engineer")
  if (de && (de.vote === "VETO" || de.flags?.includes("DATA_BLOCK"))) {
    agents.push("data_engineer")
    reason = de.reasoning
  }
  const phys = outputs.find((o) => o.agentId === "physicist")
  if (phys && (phys.vote === "VETO" || phys.flags?.includes("VOLATILITY_CRISIS"))) {
    agents.push("physicist")
    reason = reason || phys.reasoning
  }
  const math = outputs.find((o) => o.agentId === "mathematician")
  if (math) {
    const noise = math.metrics.noise ?? 0
    if (noise > STYLE.noiseVeto) {
      agents.push("mathematician")
      reason = reason || `Market too choppy/noisy (noise=${noise.toFixed(3)} > ${STYLE.noiseVeto})`
    } else if (math.metrics.anomaly === 1 || math.flags?.includes("anomaly")) {
      agents.push("mathematician")
      reason = reason || "Anomalous move detected (|Z| > 4σ), holding"
    }
  }
  return { vetoed: agents.length > 0, reason, agents }
}

// Build consensus using the Rust weighted-score scheme.
function buildConsensus(
  outputs: AgentOutput[],
  weights: Map<string, number>,
  veto: VetoInfo,
  input: AgentInput,
): TeamConsensus {
  const last = input.price || input.closes[input.closes.length - 1] || 0

  if (veto.vetoed) {
    return {
      signal: "WAIT",
      confidence: 0,
      agreeingAgents: [],
      dissentingAgents: [],
      vetoAgents: veto.agents,
      reasoning: `VETO triggered: ${veto.reason}`,
      entry: last,
      tp: last,
      sl: last,
    }
  }

  let score = 0
  let activeW = 0
  let buyCount = 0
  let sellCount = 0
  for (const o of outputs) {
    if (o.vote !== "LONG" && o.vote !== "SHORT") continue
    const w = weights.get(o.agentId) ?? 0.05
    const sign = o.vote === "LONG" ? 1 : -1
    if (sign > 0) buyCount++
    else sellCount++
    score += w * o.confidence * sign
    activeW += w
  }

  if (activeW <= 0.05) {
    return {
      signal: "WAIT",
      confidence: 0,
      agreeingAgents: [],
      dissentingAgents: [],
      vetoAgents: [],
      reasoning: "Team deadlocked / waiting for a clearer setup",
      entry: last,
      tp: last,
      sl: last,
    }
  }
  score /= activeW
  const confidence = Math.min(1, Math.abs(score))

  let signal: AgentVote = "WAIT"
  if (confidence >= STYLE.minConfidence) {
    if (score > 0 && buyCount >= STYLE.minAgree) signal = "LONG"
    else if (score < 0 && sellCount >= STYLE.minAgree) signal = "SHORT"
  }

  const agreeingAgents = outputs.filter((o) => o.vote === signal).map((o) => o.agentId)
  const dissentingAgents = outputs
    .filter((o) => o.vote !== signal && o.vote !== "WAIT" && o.vote !== "VETO")
    .map((o) => o.agentId)

  // Targets from ATR.
  const atrOut = outputs.find((o) => o.metrics.atr && o.metrics.atr > 0)
  const atr = Math.max(atrOut?.metrics.atr ?? last * 0.015, last * 0.002)
  let entry = last
  let tp = last
  let sl = last
  if (signal === "LONG") {
    entry = last - atr * 0.3
    tp = entry + atr * STYLE.tpAtrMult * 1.5
    sl = entry - atr * STYLE.slAtrMult
  } else if (signal === "SHORT") {
    entry = last + atr * 0.3
    tp = entry - atr * STYLE.tpAtrMult * 1.5
    sl = entry + atr * STYLE.slAtrMult
  }

  const topReasons = outputs
    .filter((o) => o.vote === signal)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
    .map((o) => `${o.agentId}: ${o.reasoning}`)
  const reasoning =
    signal === "WAIT"
      ? `No consensus (score=${score.toFixed(3)}, conf=${confidence.toFixed(3)} < ${STYLE.minConfidence})`
      : `${signal} consensus (score=${score.toFixed(3)}) — ${topReasons.join(" | ")}`

  return {
    signal,
    confidence: Number(confidence.toFixed(3)),
    agreeingAgents,
    dissentingAgents,
    vetoAgents: [],
    reasoning,
    entry: Number(entry.toFixed(2)),
    tp: Number(tp.toFixed(2)),
    sl: Number(sl.toFixed(2)),
  }
}

function emptyConsensus(reason: string, price: number): TeamConsensus {
  return {
    signal: "WAIT",
    confidence: 0,
    agreeingAgents: [],
    dissentingAgents: [],
    vetoAgents: [],
    reasoning: reason,
    entry: price || 0,
    tp: price || 0,
    sl: price || 0,
  }
}

function ema(closes: number[], period: number): number {
  if (closes.length === 0) return 0
  if (closes.length < period) return closes.reduce((a, b) => a + b, 0) / closes.length
  const k = 2 / (period + 1)
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (const c of closes.slice(period)) e = c * k + e * (1 - k)
  return e
}

export { ensureInitialized, buildConsensus, detectVeto }
