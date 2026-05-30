import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function fmtUsd(n: number, opts: { decimals?: number; sign?: boolean } = {}) {
  const { decimals = 2, sign = false } = opts
  const s = n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return sign && n > 0 ? `+${s}` : s
}

export function fmtPct(n: number, decimals = 2) {
  const s = n.toFixed(decimals)
  return `${n > 0 ? "+" : ""}${s}%`
}

export function fmtCompact(n: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n)
}
