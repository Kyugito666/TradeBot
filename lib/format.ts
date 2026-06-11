export function usd(n: number, digits = 0): string {
  const sign = n < 0 ? "-" : ""
  return (
    sign +
    "$" +
    Math.abs(n).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  )
}

export function num(n: number, maxDigits = 2): string {
  if (!n || n === 0) return "0"
  
  // Dynamically show more digits for very small altcoins (like SHIB)
  let digits = maxDigits
  const abs = Math.abs(n)
  if (abs < 0.001) digits = Math.max(6, maxDigits)
  else if (abs < 0.1) digits = Math.max(5, maxDigits)
  else if (abs < 1) digits = Math.max(4, maxDigits)

  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: Math.max(digits, maxDigits),
  })
}

export function pct(n: number, digits = 2): string {
  return (n > 0 ? "+" : "") + n.toFixed(digits) + "%"
}

export function compact(n: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)
}

export function uptime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`
}
