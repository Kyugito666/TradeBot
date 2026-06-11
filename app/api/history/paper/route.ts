import { NextResponse } from 'next/server';

const RUST_BRAIN_URL = "http://127.0.0.1:8080";
const PYTHON_ML_URL = "http://127.0.0.1:5000";

// Bridge a closed trade to Rust Brain's binary DB (fire-and-forget)
async function bridgeToRustBrain(trade: any) {
  try {
    const payload = {
      open_ts: trade.openedAt || Date.now(),
      close_ts: trade.closedAt || Date.now(),
      symbol: trade.symbol || "",
      direction: trade.side || "BUY",
      entry: trade.entry || 0,
      tp: trade.tp || 0,
      sl: trade.sl || 0,
      close_price: trade.exitPrice || trade.entry || 0,
      is_win: (trade.pnlPct || 0) > 0,
      rr: trade.pnlR || 0,
      is_real_money: false,
      is_shadow: false,
    };
    await fetch(`${RUST_BRAIN_URL}/api/save_trade`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Fire-and-forget: Rust brain might be offline, that's OK
  }
}

export async function GET() {
  try {
    const res = await fetch(`${PYTHON_ML_URL}/api/ml/get_paper_history`, { cache: "no-store" });
    if (!res.ok) throw new Error("ML Engine error");
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const tradeData = await req.json();

    // 1) Save to Python ML Engine (Parquet — for ML training)
    const pyPromise = fetch(`${PYTHON_ML_URL}/api/ml/save_paper_history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tradeData),
    }).catch(() => null);

    // 2) Bridge to Rust Brain binary DB (for Team Performance / Evolution)
    if (Array.isArray(tradeData)) {
      // Full history list — bridge each closed trade
      for (const t of tradeData) {
        if (t.exitPrice || t.closedAt) bridgeToRustBrain(t);
      }
    } else if (tradeData.exitPrice || tradeData.closedAt) {
      // Single closed trade
      bridgeToRustBrain(tradeData);
    }

    const pyRes = await pyPromise;
    const data = pyRes ? await pyRes.json().catch(() => ({ ok: true })) : { ok: true };
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const res = await fetch(`${PYTHON_ML_URL}/api/ml/clear_paper_history`, { method: "POST" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
