// ────────────────────────────────────────────────────────────────────────────────
// Agent Registry — Flexible system for adding/removing agents without architecture changes
// ────────────────────────────────────────────────────────────────────────────────

import type { IAgent, AgentRegistry } from "./types"

class AgentRegistryImpl implements AgentRegistry {
  agents: Map<string, IAgent> = new Map()

  register(agent: IAgent): void {
    if (this.agents.has(agent.id)) {
      console.warn(`[AgentRegistry] Agent ${agent.id} already registered, replacing.`)
    }
    this.agents.set(agent.id, agent)
    console.log(`[AgentRegistry] Registered agent: ${agent.name} (${agent.id})`)
  }

  unregister(agentId: string): void {
    if (this.agents.delete(agentId)) {
      console.log(`[AgentRegistry] Unregistered agent: ${agentId}`)
    }
  }

  getAgent(agentId: string): IAgent | undefined {
    return this.agents.get(agentId)
  }

  getAllAgents(): IAgent[] {
    return Array.from(this.agents.values())
  }

  getEnabledAgents(): IAgent[] {
    return this.getAllAgents().filter(a => a.enabled)
  }
}

// Singleton registry instance
export const agentRegistry = new AgentRegistryImpl()

// Helper to create agents with default structure
export function createAgent(config: {
  id: string
  name: string
  category: IAgent["category"]
  weight?: number
  enabled?: boolean
  analyze: IAgent["analyze"]
}): IAgent {
  return {
    id: config.id,
    name: config.name,
    category: config.category,
    weight: config.weight ?? 1.0,
    enabled: config.enabled ?? true,
    analyze: config.analyze,
  }
}
