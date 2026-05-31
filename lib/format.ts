// Use manual formatting to avoid hydration mismatches from locale differences

function formatWithCommas(n: number, digits: number): string {
  const fixed = Math.abs(n).toFixed(digits)
  const [int, dec] = fixed.split(".")
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return dec !== undefined ? `${withCommas}.${dec}` : withCommas
}

export function usd(n: number, digits = 0): string {
  const sign = n < 0 ? "-" : ""
  return sign + "$" + formatWithCommas(n, digits)
}

export function num(n: number, digits = 2): string {
  const sign = n < 0 ? "-" : ""
  return sign + formatWithCommas(n, digits)
}

export function pct(n: number, digits = 2): string {
  return (n > 0 ? "+" : "") + n.toFixed(digits) + "%"
}

export function compact(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? "-" : ""
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(1) + "B"
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + "M"
  if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + "K"
  return sign + abs.toFixed(0)
}

export function uptime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h}h ${m.toString().padStart(2, "0")}m ${s.toString().padStart(2, "0")}s`
}
