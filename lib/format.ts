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

export function num(n: number, digits = 2): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
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
