import { NextResponse } from "next/server";

const RUST_BRAIN_URL = "http://127.0.0.1:8080";

export async function GET() {
  try {
    const res = await fetch(`${RUST_BRAIN_URL}/api/shadow-trades`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`Rust brain returned ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json(
      { trades: [], error: error.message || "Rust brain offline" },
      { status: 502 }
    );
  }
}
