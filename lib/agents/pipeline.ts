// ────────────────────────────────────────────────────────────────────────────────
// Analysis Pipeline — Runs all agents with robust progress tracking
// CRITICAL: Ensures pipeline always completes (fixes 2/3 stuck issue)
// ────────────────────────────────────────────────────────────────────────────────

import { agentRegistry } from "./registry"
import { registerBuiltinAgents } from "./builtin-agents"
import type {
  AgentInput,
  AgentOutput,
  AgentVote,
  PipelineProgress,
  PipelineStage,
  TeamConsensus,
} from "./types"

// Ensure agents are registered
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
  error?: string
}

type ProgressCallback = (progress: PipelineProgress) => void

function createProgress(stage: PipelineStage, current: number, total: number, message: string): PipelineProgress {
  return {
    stage,
    currentStep: current,
    totalSteps: total,
    agentsCompleted: 0,
    totalAgents: 0,
    message,
    startedAt: Date.now(),
  }
}

export async function runAnalysisPipeline(
  input: AgentInput,
  onProgress?: ProgressCallback
): Promise<PipelineResult> {
  ensureInitialized()
  
  const agents = agentRegistry.getEnabledAgents()
  const totalSteps = 6 // Fixed number of pipeline stages
  const startTime = Date.now()
  
  const updateProgress = (stage: PipelineStage, step: number, message: string, agentsComplete = 0) => {
    const progress: PipelineProgress = {
      stage,
      currentStep: step,
      totalSteps,
      agentsCompleted: agentsComplete,
      totalAgents: agents.length,
      message,
      startedAt: startTime,
    }
    onProgress?.(progress)
    return progress
  }
  
  let lastProgress: PipelineProgress
  
  try {
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 1: VALIDATE INPUT (Step 1/6)
    // ═══════════════════════════════════════════════════════════════════════════
    lastProgress = updateProgress("fetching_data", 1, "Validating market data...")
    
    if (!input.closes?.length) {
      throw new Error("No price data available")
    }
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 2: RUN ALL AGENTS (Step 2/6)
    // ═══════════════════════════════════════════════════════════════════════════
    lastProgress = updateProgress("running_agents", 2, `Running ${agents.length} agents...`)
    
    const agentOutputs: AgentOutput[] = []
    
    // Run agents sequentially with progress updates
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i]
      lastProgress = updateProgress(
        "running_agents", 
        2, 
        `Agent ${i + 1}/${agents.length}: ${agent.name}...`,
        i
      )
      
      try {
        const output = await Promise.race([
          agent.analyze(input),
          new Promise<AgentOutput>((_, reject) => 
            setTimeout(() => reject(new Error("Agent timeout")), 5000)
          )
        ])
        agentOutputs.push(output)
      } catch (err) {
        // Agent failed but pipeline continues
        console.error(`[Pipeline] Agent ${agent.id} failed:`, err)
        agentOutputs.push({
          agentId: agent.id,
          vote: "WAIT",
          confidence: 0,
          reasoning: `Agent error: ${err instanceof Error ? err.message : "Unknown"}`,
          metrics: {}
        })
      }
    }
    
    lastProgress = updateProgress("running_agents", 2, "All agents completed", agents.length)
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 3: AGGREGATE VOTES (Step 3/6)
    // ═══════════════════════════════════════════════════════════════════════════
    lastProgress = updateProgress("aggregating_votes", 3, "Aggregating agent votes...")
    
    const weightedVotes = aggregateVotes(agentOutputs, agents)
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 4: RISK CHECK (Step 4/6)
    // ═══════════════════════════════════════════════════════════════════════════
    lastProgress = updateProgress("risk_check", 4, "Performing risk assessment...")
    
    const vetoAgents = agentOutputs.filter(o => o.vote === "VETO")
    const hasVeto = vetoAgents.length > 0
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 5: GENERATE SIGNAL (Step 5/6)
    // ═══════════════════════════════════════════════════════════════════════════
    lastProgress = updateProgress("generating_signal", 5, "Generating consensus signal...")
    
    const consensus = buildConsensus(
      weightedVotes,
      agentOutputs,
      hasVeto,
      vetoAgents,
      input
    )
    
    // ═══════════════════════════════════════════════════════════════════════════
    // STAGE 6: COMPLETE (Step 6/6)
    // ═══════════════════════════════════════════════════════════════════════════
    lastProgress = updateProgress("complete", 6, "Analysis complete")
    lastProgress.completedAt = Date.now()
    
    return {
      consensus,
      agentOutputs,
      progress: lastProgress
    }
    
  } catch (err) {
    // Pipeline error - still return a result
    const errorMsg = err instanceof Error ? err.message : "Unknown pipeline error"
    console.error("[Pipeline] Error:", errorMsg)
    
    lastProgress = updateProgress("error", lastProgress?.currentStep ?? 0, `Error: ${errorMsg}`)
    lastProgress.error = errorMsg
    
    return {
      consensus: {
        signal: "WAIT",
        confidence: 0,
        agreeingAgents: [],
        dissentingAgents: [],
        vetoAgents: [],
        reasoning: `Pipeline error: ${errorMsg}`,
        entry: 0,
        tp: 0,
        sl: 0
      },
      agentOutputs: [],
      progress: lastProgress,
      error: errorMsg
    }
  }
}

interface WeightedVote {
  long: number
  short: number
  wait: number
  total: number
}

function aggregateVotes(outputs: AgentOutput[], agents: ReturnType<typeof agentRegistry.getEnabledAgents>): WeightedVote {
  const votes: WeightedVote = { long: 0, short: 0, wait: 0, total: 0 }
  
  for (const output of outputs) {
    const agent = agents.find(a => a.id === output.agentId)
    const weight = agent?.weight ?? 1.0
    const weighted = weight * output.confidence
    
    if (output.vote === "LONG") votes.long += weighted
    else if (output.vote === "SHORT") votes.short += weighted
    else if (output.vote === "WAIT") votes.wait += weighted
    // VETO is handled separately
    
    votes.total += weighted
  }
  
  return votes
}

function buildConsensus(
  votes: WeightedVote,
  outputs: AgentOutput[],
  hasVeto: boolean,
  vetoOutputs: AgentOutput[],
  input: AgentInput
): TeamConsensus {
  const last = input.closes[input.closes.length - 1] || 0
  
  // If any agent vetoes, force WAIT
  if (hasVeto) {
    const vetoReasons = vetoOutputs.map(v => v.reasoning).join("; ")
    return {
      signal: "WAIT",
      confidence: 0,
      agreeingAgents: [],
      dissentingAgents: outputs.filter(o => o.vote !== "VETO" && o.vote !== "WAIT").map(o => o.agentId),
      vetoAgents: vetoOutputs.map(o => o.agentId),
      reasoning: `VETO triggered: ${vetoReasons}`,
      entry: last,
      tp: last,
      sl: last
    }
  }
  
  // Determine winning signal
  const threshold = votes.total * 0.15 // Need 15% net weight to have a signal
  const net = votes.long - votes.short
  
  let signal: AgentVote = "WAIT"
  if (net > threshold) signal = "LONG"
  else if (net < -threshold) signal = "SHORT"
  
  // Calculate confidence based on agreement
  const maxPossible = Math.max(votes.long, votes.short, votes.wait)
  const confidence = votes.total > 0 
    ? Math.min(0.95, (maxPossible / votes.total) * (Math.abs(net) / votes.total + 0.3))
    : 0
  
  // Categorize agents
  const agreeingAgents = outputs
    .filter(o => o.vote === signal)
    .map(o => o.agentId)
  const dissentingAgents = outputs
    .filter(o => o.vote !== signal && o.vote !== "WAIT" && o.vote !== "VETO")
    .map(o => o.agentId)
  
  // Build reasoning
  const topAgents = outputs
    .filter(o => o.vote === signal)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 3)
  const reasoning = signal === "WAIT"
    ? `No consensus: LONG=${votes.long.toFixed(2)}, SHORT=${votes.short.toFixed(2)}, WAIT=${votes.wait.toFixed(2)}`
    : `${signal} consensus from ${agreeingAgents.join(", ")}: ${topAgents.map(a => a.reasoning).join("; ")}`
  
  // Calculate targets using ATR if available
  const atrOutput = outputs.find(o => o.metrics.atr)
  const atr = atrOutput?.metrics.atr ?? (last * 0.015) // Default 1.5%
  
  let entry = last
  let tp = last
  let sl = last
  
  if (signal === "LONG") {
    tp = entry + atr * 2
    sl = entry - atr * 1.2
  } else if (signal === "SHORT") {
    tp = entry - atr * 2
    sl = entry + atr * 1.2
  }
  
  return {
    signal,
    confidence: Number(confidence.toFixed(3)),
    agreeingAgents,
    dissentingAgents,
    vetoAgents: [],
    reasoning,
    entry: Number(entry.toFixed(2)),
    tp: Number(tp.toFixed(2)),
    sl: Number(sl.toFixed(2))
  }
}

// Export for testing
export { ensureInitialized, aggregateVotes, buildConsensus }
