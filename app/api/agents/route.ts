import { NextResponse } from "next/server"
const ENGINE_URL = process.env.ENGINE_URL || "http://localhost:8765"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function GET() {
  try {
    const res = await fetch(`${ENGINE_URL}/api/engine/consensus`, {
      cache: "no-store",
    })
    if (res.ok) {
      return NextResponse.json(await res.json())
    }
    return NextResponse.json({ ok: false, ts: Date.now(), state: null, error: "Engine error" })
  } catch (err: any) {
    return NextResponse.json({ ok: false, ts: Date.now(), state: null, error: err.message })
  }
}
