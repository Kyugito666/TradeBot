import { NextResponse } from "next/server"
import { ENGINE_URL } from "@/lib/engine"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const maxDuration = 60

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const res = await fetch(`${ENGINE_URL}/api/market?${searchParams.toString()}`, {
      cache: "no-store",
      headers: { accept: "application/json" }
    })
    if (res.ok) {
      const data = await res.json()
      return NextResponse.json(data)
    }
    return NextResponse.json([])
  } catch (err: any) {
    return NextResponse.json([])
  }
}
