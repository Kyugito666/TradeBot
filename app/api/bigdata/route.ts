import { NextResponse } from "next/server";

const RUST_BRAIN_URL = "http://127.0.0.1:8080";
const PYTHON_ML_URL = "http://127.0.0.1:5000";

export async function GET() {
  const results: Record<string, any> = { stats: null, agents: {} };

  try {
    const [bdRes, agRes] = await Promise.allSettled([
      fetch(`${RUST_BRAIN_URL}/api/bigdata/stats`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      }),
      fetch(`${PYTHON_ML_URL}/api/ml/agent_status`, {
        cache: "no-store",
        signal: AbortSignal.timeout(3000),
      }),
    ]);

    if (bdRes.status === "fulfilled" && bdRes.value.ok) {
      results.stats = await bdRes.value.json();
    }

    if (agRes.status === "fulfilled" && agRes.value.ok) {
      results.agents = await agRes.value.json();
    }

    return NextResponse.json(results);
  } catch (error: any) {
    return NextResponse.json(results, { status: 502 });
  }
}
