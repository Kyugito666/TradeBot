"use client";

import React, { useEffect, useState } from "react";
import { Ghost, TrendingUp, TrendingDown, Clock, Target, AlertTriangle } from "lucide-react";
import { Panel } from "./ui-kit";
import { num } from "@/lib/format";

/* ── Types ─────────────────────────────────────────────────────────── */
interface ShadowTrade {
  id: number;
  symbol: string;
  direction: string;
  entry: number;
  tp: number;
  sl: number;
  open_ts: number;
  close_ts?: number;
  close_price?: number;
  is_win?: boolean;
  veto_reason: string;
  status: "open" | "closed";
}

/* ── Component ─────────────────────────────────────────────────────── */
export function ShadowPanel() {
  const [trades, setTrades] = useState<ShadowTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState({ total: 0, wins: 0, losses: 0, winRate: 0, pending: 0 });

  useEffect(() => {
    const fetchShadow = async () => {
      try {
        const res = await fetch("/api/shadow-trades");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const list: ShadowTrade[] = Array.isArray(data?.trades) ? data.trades : [];
        setTrades(list);

        const closed = list.filter((t) => t.status === "closed");
        const wins = closed.filter((t) => t.is_win);
        setStats({
          total: closed.length,
          wins: wins.length,
          losses: closed.length - wins.length,
          winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
          pending: list.filter((t) => t.status === "open").length,
        });

        setError(null);
      } catch (e: any) {
        setError(e.message || "Failed to fetch shadow trades");
      } finally {
        setLoading(false);
      }
    };

    fetchShadow();
    const iv = setInterval(fetchShadow, 5000);
    return () => clearInterval(iv);
  }, []);

  const openTrades = trades.filter((t) => t.status === "open");
  const closedTrades = trades.filter((t) => t.status === "closed").slice(-50).reverse();

  return (
    <div className="flex flex-col gap-3">
      {/* Header Info */}
      <Panel>
        <div className="flex items-center gap-2 mb-3">
          <Ghost size={16} className="text-violet-400" />
          <span className="text-sm font-semibold">Shadow / Forward-Test Trades</span>
          <span className="ml-auto text-[10px] text-muted-foreground uppercase tracking-wider">
            Isolated from paper positions
          </span>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Shadow trades run in parallel with real signals to evaluate agent performance
          without affecting your portfolio. They are <strong>completely isolated</strong> from
          paper and live positions.
        </p>
      </Panel>

      {/* Stats Strip */}
      <div className="grid grid-cols-5 gap-2">
        {[
          { label: "Total Closed", value: stats.total, color: "text-foreground" },
          { label: "Wins", value: stats.wins, color: "text-green-400" },
          { label: "Losses", value: stats.losses, color: "text-red-400" },
          { label: "Win Rate", value: `${stats.winRate.toFixed(1)}%`, color: stats.winRate >= 50 ? "text-green-400" : "text-red-400" },
          { label: "Pending", value: stats.pending, color: "text-amber-400" },
        ].map((s) => (
          <div key={s.label} className="rounded-md border border-border/40 bg-card/30 px-3 py-2 text-center">
            <div className={`text-sm font-bold tabular-nums ${s.color}`}>{s.value}</div>
            <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Open Shadow Trades */}
      {openTrades.length > 0 && (
        <Panel>
          <div className="flex items-center gap-2 mb-2">
            <Clock size={13} className="text-amber-400" />
            <span className="text-xs font-semibold">Open Shadow Positions ({openTrades.length})</span>
          </div>
          <div className="space-y-1">
            {openTrades.map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded border border-border/30 bg-muted/20 px-2 py-1.5 text-xs">
                {t.direction === "BUY" ? (
                  <TrendingUp size={12} className="text-green-400" />
                ) : (
                  <TrendingDown size={12} className="text-red-400" />
                )}
                <span className="font-mono font-medium">{t.symbol}</span>
                <span className={t.direction === "BUY" ? "text-green-400" : "text-red-400"}>{t.direction}</span>
                <span className="text-muted-foreground">@ {num(t.entry)}</span>
                <span className="ml-auto text-muted-foreground">
                  TP {num(t.tp)} · SL {num(t.sl)}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Closed Shadow Trades History */}
      <Panel>
        <div className="flex items-center gap-2 mb-2">
          <Target size={13} className="text-violet-400" />
          <span className="text-xs font-semibold">Shadow History (last 50)</span>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-muted-foreground animate-pulse">
            Loading shadow trades...
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 py-6 justify-center text-xs text-amber-400">
            <AlertTriangle size={14} />
            <span>Engine offline — {error}</span>
          </div>
        ) : closedTrades.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No shadow trades yet. They will appear once the consensus engine generates vetoed or shadow signals.
          </div>
        ) : (
          <div className="max-h-[400px] overflow-y-auto scroll-thin space-y-1">
            {closedTrades.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-2 rounded border border-border/20 bg-card/20 px-2 py-1 text-[11px]"
              >
                <span className={t.is_win ? "text-green-400 font-bold" : "text-red-400 font-bold"}>
                  {t.is_win ? "W" : "L"}
                </span>
                <span className="font-mono">{t.symbol}</span>
                <span className={t.direction === "BUY" ? "text-green-400" : "text-red-400"}>
                  {t.direction}
                </span>
                <span className="text-muted-foreground">
                  {num(t.entry)} → {num(t.close_price ?? 0)}
                </span>
                {t.veto_reason && (
                  <span className="ml-auto text-[9px] text-muted-foreground truncate max-w-[200px]">
                    {t.veto_reason}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
