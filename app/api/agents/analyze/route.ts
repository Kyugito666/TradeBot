import { NextResponse } from "next/server"
const ENGINE_URL = process.env.ENGINE_URL || "http://localhost:8765"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 60

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const res = await fetch(`${ENGINE_URL}/api/engine/consensus?${searchParams.toString()}`, {
      cache: "no-store",
    })
    if (res.ok) {
      return NextResponse.json(await res.json())
    }
    return NextResponse.json({ ok: false, error: "Engine error" }, { status: res.status })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 502 })
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const res = await fetch(`${ENGINE_URL}/api/agents/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    if (res.ok) {
      return NextResponse.json(await res.json())
    }
    return NextResponse.json({ ok: false, error: "Engine error" }, { status: res.status })
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 502 })
  }
}
