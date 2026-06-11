import { NextResponse } from "next/server";

const PYTHON_ML_URL = "http://127.0.0.1:5000";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await fetch(`${PYTHON_ML_URL}/api/ml/train_all_agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json(
      { status: "error", message: error.message || "ML Engine offline" },
      { status: 502 }
    );
  }
}
