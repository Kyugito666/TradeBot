import type React from "react"
import { cn } from "@/lib/utils"

export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title?: React.ReactNode
  right?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn("flex min-h-0 flex-col rounded-lg border border-border bg-panel", className)}
    >
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {title}
          </h2>
          {right}
        </header>
      )}
      <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
    </section>
  )
}

export function StatusDot({
  tone = "muted",
  pulse = false,
  className,
}: {
  tone?: "positive" | "negative" | "warning" | "primary" | "muted"
  pulse?: boolean
  className?: string
}) {
  const map: Record<string, string> = {
    positive: "bg-positive",
    negative: "bg-negative",
    warning: "bg-warning",
    primary: "bg-primary",
    muted: "bg-muted-foreground",
  }
  return (
    <span className={cn("relative inline-flex h-2 w-2", className)}>
      {pulse && (
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", map[tone])} />
      )}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", map[tone])} />
    </span>
  )
}

export function Tag({
  children,
  tone = "muted",
  className,
}: {
  children: React.ReactNode
  tone?: "positive" | "negative" | "warning" | "primary" | "muted" | "outline"
  className?: string
}) {
  const map: Record<string, string> = {
    positive: "bg-positive/12 text-positive border-positive/30",
    negative: "bg-negative/12 text-negative border-negative/30",
    warning: "bg-warning/12 text-warning border-warning/30",
    primary: "bg-primary/12 text-primary border-primary/30",
    muted: "bg-muted text-muted-foreground border-border",
    outline: "bg-transparent text-foreground border-border",
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider tabular",
        map[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Stat({
  label,
  value,
  sub,
  tone,
  mono = true,
  className,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  tone?: "positive" | "negative" | "warning" | "foreground"
  mono?: boolean
  className?: string
}) {
  const toneMap: Record<string, string> = {
    positive: "text-positive",
    negative: "text-negative",
    warning: "text-warning",
    foreground: "text-foreground",
  }
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-lg font-semibold leading-tight tabular",
          mono && "font-mono",
          tone ? toneMap[tone] : "text-foreground",
        )}
      >
        {value}
      </span>
      {sub && <span className="text-[10px] tabular text-muted-foreground">{sub}</span>}
    </div>
  )
}

export function Sparkline({
  data,
  tone = "primary",
  width = 92,
  height = 26,
}: {
  data: number[]
  tone?: "positive" | "negative" | "primary"
  width?: number
  height?: number
}) {
  if (!data.length) return null
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const stepX = width / (data.length - 1)
  const points = data
    .map((d, i) => `${(i * stepX).toFixed(1)},${(height - ((d - min) / range) * height).toFixed(1)}`)
    .join(" ")
  const stroke =
    tone === "positive" ? "hsl(var(--positive))" : tone === "negative" ? "hsl(var(--negative))" : "hsl(var(--primary))"
  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden="true">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  )
}

export function Meter({ value, tone = "primary" }: { value: number; tone?: "positive" | "negative" | "warning" | "primary" }) {
  const map: Record<string, string> = {
    positive: "bg-positive",
    negative: "bg-negative",
    warning: "bg-warning",
    primary: "bg-primary",
  }
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full transition-all duration-500", map[tone])} style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </div>
  )
}
