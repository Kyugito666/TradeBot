"use client"

import { useEffect, useState } from "react"
import { 
  CheckCircle2, 
  Circle, 
  Loader2, 
  AlertCircle,
  Brain,
  TrendingUp,
  Shield,
  Activity
} from "lucide-react"
import { Panel, Tag, Meter, LoadingState } from "./ui-kit"
import { cn } from "@/lib/utils"

export interface PipelineProgress {
  stage: string
  currentStep: number
  totalSteps: number
  agentsCompleted: number
  totalAgents: number
  message: string
  startedAt: number
  completedAt?: number
  error?: string
}

const STAGE_INFO: Record<string, { label: string; icon: React.ReactNode }> = {
  idle: { label: "Idle", icon: <Circle className="h-4 w-4" /> },
  fetching_data: { label: "Fetching Data", icon: <Activity className="h-4 w-4" /> },
  running_agents: { label: "Running Agents", icon: <Brain className="h-4 w-4" /> },
  aggregating_votes: { label: "Aggregating Votes", icon: <TrendingUp className="h-4 w-4" /> },
  risk_check: { label: "Risk Assessment", icon: <Shield className="h-4 w-4" /> },
  generating_signal: { label: "Generating Signal", icon: <Activity className="h-4 w-4" /> },
  self_evaluation: { label: "Self Evaluation", icon: <Brain className="h-4 w-4" /> },
  complete: { label: "Complete", icon: <CheckCircle2 className="h-4 w-4" /> },
  error: { label: "Error", icon: <AlertCircle className="h-4 w-4" /> },
}

export function AnalysisProgress({
  progress,
  className,
}: {
  progress: PipelineProgress | null
  className?: string
}) {
  const [elapsedMs, setElapsedMs] = useState(0)
  
  useEffect(() => {
    if (!progress || progress.stage === "complete" || progress.stage === "error") {
      return
    }
    
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - progress.startedAt)
    }, 100)
    
    return () => clearInterval(interval)
  }, [progress])
  
  if (!progress) {
    return (
      <Panel title="Analysis Pipeline" className={className}>
        <LoadingState label="Initializing pipeline…" />
      </Panel>
    )
  }
  
  const { stage, currentStep, totalSteps, agentsCompleted, totalAgents, message, error } = progress
  const stageInfo = STAGE_INFO[stage] || STAGE_INFO.idle
  const progressPct = totalSteps > 0 ? currentStep / totalSteps : 0
  const isComplete = stage === "complete"
  const isError = stage === "error"
  const elapsed = progress.completedAt 
    ? progress.completedAt - progress.startedAt 
    : elapsedMs
  
  return (
    <Panel 
      title="Analysis Pipeline" 
      right={
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            {(elapsed / 1000).toFixed(1)}s
          </span>
          <Tag tone={isComplete ? "positive" : isError ? "negative" : "primary"}>
            {currentStep}/{totalSteps}
          </Tag>
        </div>
      }
      className={className}
    >
      <div className="p-3 space-y-3">
        {/* Main progress bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className={cn(
                "flex items-center gap-1.5",
                isComplete && "text-positive",
                isError && "text-negative",
                !isComplete && !isError && "text-primary"
              )}>
                {stage === "running_agents" || (!isComplete && !isError) ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  stageInfo.icon
                )}
                <span className="font-semibold">{stageInfo.label}</span>
              </span>
            </div>
            <span className="text-muted-foreground font-mono">
              {(progressPct * 100).toFixed(0)}%
            </span>
          </div>
          <Meter 
            value={progressPct} 
            tone={isComplete ? "positive" : isError ? "negative" : "primary"} 
          />
        </div>
        
        {/* Agent progress (when running agents) */}
        {stage === "running_agents" && totalAgents > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">Agent Progress</span>
              <span className="font-mono text-foreground">
                {agentsCompleted}/{totalAgents}
              </span>
            </div>
            <Meter value={agentsCompleted / totalAgents} tone="primary" />
          </div>
        )}
        
        {/* Status message */}
        <p className={cn(
          "text-[11px] leading-relaxed",
          isError ? "text-negative" : "text-muted-foreground"
        )}>
          {message}
        </p>
        
        {/* Step indicators */}
        <div className="flex items-center justify-between pt-2">
          {Array.from({ length: totalSteps }, (_, i) => {
            const stepNum = i + 1
            const isCurrentOrPast = stepNum <= currentStep
            const isCurrent = stepNum === currentStep && !isComplete
            
            return (
              <div 
                key={i} 
                className={cn(
                  "flex items-center justify-center rounded-full w-6 h-6 text-[10px] font-mono font-bold transition-colors",
                  isComplete && "bg-positive/20 text-positive",
                  isError && stepNum === currentStep && "bg-negative/20 text-negative",
                  !isComplete && !isError && isCurrentOrPast && "bg-primary/20 text-primary",
                  !isComplete && !isError && !isCurrentOrPast && "bg-muted text-muted-foreground",
                  isCurrent && "ring-2 ring-primary ring-offset-1 ring-offset-background"
                )}
              >
                {isComplete || (isCurrentOrPast && !isCurrent) ? (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                ) : (
                  stepNum
                )}
              </div>
            )
          })}
        </div>
        
        {/* Error details */}
        {error && (
          <div className="mt-2 rounded border border-negative/30 bg-negative/10 p-2">
            <p className="text-[11px] text-negative">{error}</p>
          </div>
        )}
      </div>
    </Panel>
  )
}
