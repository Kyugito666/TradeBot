"use client"

import { useState } from "react"
import { 
  Brain, 
  TrendingUp, 
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Activity,
  Scale,
  Shield,
  BarChart3
} from "lucide-react"
import { Panel, Tag, Meter, Stat } from "./ui-kit"
import { cn } from "@/lib/utils"
import { pct } from "@/lib/format"

interface AgentOutput {
  agentId: string
  vote: "LONG" | "SHORT" | "WAIT" | "VETO"
  confidence: number
  reasoning: string
  metrics: Record<string, number>
}

interface AgentState {
  tunables: {
    weight: number
    convictionScale: number
    activationGate: number
  }
  scorecard: {
    trades: number
    correct: number
    incorrect: number
    accuracy: number
    recentAccuracy: number
    pnlContrib: number
    wrongStreak: number
  }
}

interface TeamScorecard {
  trades: number
  wins: number
  losses: number
  netPnlR: number
  peakR: number
  drawdownR: number
  winStreak: number
  lossStreak: number
  conservatismBias: number
}

interface AgentInfo {
  id: string
  name: string
  category: string
  weight: number
  enabled: boolean
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  trend: <TrendingUp className="h-3.5 w-3.5" />,
  mean_revert: <Activity className="h-3.5 w-3.5" />,
  sentiment: <Scale className="h-3.5 w-3.5" />,
  volume: <BarChart3 className="h-3.5 w-3.5" />,
  risk: <Shield className="h-3.5 w-3.5" />,
  macro: <Activity className="h-3.5 w-3.5" />,
}

const VOTE_COLORS: Record<string, string> = {
  LONG: "text-positive",
  SHORT: "text-negative",
  WAIT: "text-warning",
  VETO: "text-negative",
}

const VOTE_BG: Record<string, string> = {
  LONG: "bg-positive/15 border-positive/30",
  SHORT: "bg-negative/15 border-negative/30",
  WAIT: "bg-warning/15 border-warning/30",
  VETO: "bg-negative/20 border-negative/40",
}

export function AgentVotesPanel({
  outputs,
  agents,
  evolution,
  className,
}: {
  outputs: AgentOutput[]
  agents: AgentInfo[]
  evolution?: {
    team?: TeamScorecard
    agents?: Record<string, AgentState>
    recentReports?: any[]
  }
  className?: string
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  
  // Sort by confidence
  const sortedOutputs = [...outputs].sort((a, b) => b.confidence - a.confidence)
  
  // Count votes
  const voteCounts = outputs.reduce((acc, o) => {
    acc[o.vote] = (acc[o.vote] || 0) + 1
    return acc
  }, {} as Record<string, number>)
  
  return (
    <Panel 
      title="Agent Votes" 
      right={
        <div className="flex items-center gap-1.5">
          {Object.entries(voteCounts).map(([vote, count]) => (
            <Tag key={vote} tone={vote === "LONG" ? "positive" : vote === "SHORT" ? "negative" : "warning"}>
              {vote}: {count}
            </Tag>
          ))}
        </div>
      }
      className={className}
      bodyClassName="overflow-auto scroll-thin max-h-[500px]"
    >
      {/* Team summary if available */}
      {evolution?.team && evolution.team.trades > 0 && (
        <div className="border-b border-border p-3">
          <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            Team Performance
          </h4>
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <div className="text-lg font-mono font-bold text-foreground">
                {evolution.team.trades}
              </div>
              <div className="text-[9px] text-muted-foreground">Trades</div>
            </div>
            <div>
              <div className={cn(
                "text-lg font-mono font-bold",
                evolution.team.wins > evolution.team.losses ? "text-positive" : "text-negative"
              )}>
                {evolution.team.trades > 0 
                  ? ((evolution.team.wins / evolution.team.trades) * 100).toFixed(0) 
                  : 0}%
              </div>
              <div className="text-[9px] text-muted-foreground">Win Rate</div>
            </div>
            <div>
              <div className={cn(
                "text-lg font-mono font-bold",
                evolution.team.netPnlR >= 0 ? "text-positive" : "text-negative"
              )}>
                {evolution.team.netPnlR >= 0 ? "+" : ""}{evolution.team.netPnlR.toFixed(2)}R
              </div>
              <div className="text-[9px] text-muted-foreground">Net P&L</div>
            </div>
            <div>
              <div className="text-lg font-mono font-bold text-negative">
                -{evolution.team.drawdownR.toFixed(2)}R
              </div>
              <div className="text-[9px] text-muted-foreground">Max DD</div>
            </div>
          </div>
          {evolution.team.lossStreak >= 2 && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-warning">
              <AlertTriangle className="h-3 w-3" />
              <span>Loss streak: {evolution.team.lossStreak} trades</span>
            </div>
          )}
        </div>
      )}
      
      {/* Agent votes */}
      <div className="divide-y divide-border">
        {sortedOutputs.map((output) => {
          const agent = agents.find(a => a.id === output.agentId)
          const agentState = evolution?.agents?.[output.agentId]
          const isExpanded = expanded === output.agentId
          
          return (
            <div 
              key={output.agentId}
              className={cn(
                "transition-colors",
                isExpanded && "bg-muted/30"
              )}
            >
              {/* Main row */}
              <button
                onClick={() => setExpanded(isExpanded ? null : output.agentId)}
                className="w-full px-3 py-2 flex items-center gap-3 hover:bg-muted/20 transition-colors"
              >
                {/* Agent icon & name */}
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <div className={cn(
                    "flex items-center justify-center w-7 h-7 rounded shrink-0",
                    output.vote === "VETO" ? "bg-negative/20 text-negative" : "bg-muted text-muted-foreground"
                  )}>
                    {CATEGORY_ICONS[agent?.category || "trend"] || <Brain className="h-3.5 w-3.5" />}
                  </div>
                  <div className="min-w-0 text-left">
                    <div className="text-xs font-semibold truncate">
                      {agent?.name || output.agentId}
                    </div>
                    <div className="text-[9px] text-muted-foreground truncate">
                      {output.activity || agent?.category || "unknown"}
                    </div>
                  </div>
                </div>
                
                {/* Vote badge */}
                <div className={cn(
                  "shrink-0 px-2 py-1 rounded border font-mono text-xs font-bold",
                  VOTE_BG[output.vote],
                  VOTE_COLORS[output.vote]
                )}>
                  {output.vote}
                </div>
                
                {/* Confidence */}
                <div className="shrink-0 w-16 text-right">
                  <div className="font-mono text-sm font-semibold">
                    {(output.confidence * 100).toFixed(0)}%
                  </div>
                  <Meter 
                    value={output.confidence} 
                    tone={output.vote === "LONG" ? "positive" : output.vote === "SHORT" ? "negative" : "warning"} 
                  />
                </div>
                
                {/* Expand icon */}
                <div className="shrink-0 text-muted-foreground">
                  {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </div>
              </button>
              
              {/* Expanded details */}
              {isExpanded && (
                <div className="px-3 pb-3 space-y-3">
                  {/* Current activity */}
                  {output.activity && (
                    <div className="flex items-center gap-1.5">
                      <Tag tone="outline">{agent?.category || "agent"}</Tag>
                      <span className="text-[10px] text-muted-foreground truncate">{output.activity}</span>
                    </div>
                  )}
                  {/* Reasoning / current read */}
                  <div className="rounded bg-muted/50 p-2">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {output.reasoning}
                    </p>
                  </div>
                  
                  {/* Metrics */}
                  {Object.keys(output.metrics).length > 0 && (
                    <div className="grid grid-cols-3 gap-2">
                      {Object.entries(output.metrics).slice(0, 6).map(([key, val]) => (
                        <div key={key} className="text-center">
                          <div className="font-mono text-xs text-foreground">
                            {typeof val === "number" ? val.toFixed(2) : val}
                          </div>
                          <div className="text-[9px] text-muted-foreground uppercase">
                            {key.replace(/_/g, " ")}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {/* Agent state (if evolution data available) */}
                  {agentState && (
                    <div className="border-t border-border pt-2 mt-2">
                      <h5 className="text-[9px] uppercase tracking-wider text-muted-foreground mb-2">
                        Self-Evaluation Stats
                      </h5>
                      <div className="grid grid-cols-4 gap-2 text-center">
                        <div>
                          <div className="font-mono text-xs font-bold">
                            {agentState.scorecard.trades}
                          </div>
                          <div className="text-[9px] text-muted-foreground">Trades</div>
                        </div>
                        <div>
                          <div className={cn(
                            "font-mono text-xs font-bold",
                            agentState.scorecard.accuracy >= 0.5 ? "text-positive" : "text-negative"
                          )}>
                            {(agentState.scorecard.accuracy * 100).toFixed(0)}%
                          </div>
                          <div className="text-[9px] text-muted-foreground">Accuracy</div>
                        </div>
                        <div>
                          <div className={cn(
                            "font-mono text-xs font-bold",
                            agentState.scorecard.recentAccuracy >= 0.5 ? "text-positive" : "text-negative"
                          )}>
                            {(agentState.scorecard.recentAccuracy * 100).toFixed(0)}%
                          </div>
                          <div className="text-[9px] text-muted-foreground">Recent</div>
                        </div>
                        <div>
                          <div className="font-mono text-xs font-bold">
                            {agentState.tunables.weight.toFixed(2)}x
                          </div>
                          <div className="text-[9px] text-muted-foreground">Weight</div>
                        </div>
                      </div>
                      {agentState.scorecard.wrongStreak >= 2 && (
                        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-warning">
                          <AlertTriangle className="h-3 w-3" />
                          <span>Wrong streak: {agentState.scorecard.wrongStreak}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
      
      {outputs.length === 0 && (
        <div className="flex items-center justify-center p-6 text-muted-foreground">
          <Brain className="h-5 w-5 mr-2 opacity-50" />
          <span className="text-sm">No agent votes yet</span>
        </div>
      )}
    </Panel>
  )
}
