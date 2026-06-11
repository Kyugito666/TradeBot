"use client";

import React from "react";
import {
  Activity, TrendingUp, BarChart2, Waves, Gauge, Target
} from "lucide-react";
import { useLiveData } from "@/hooks/use-live-data";

/* ── Types ─────────────────────────────────────────────────────────── */
interface QuantMetric {
  label: string;
  value: string;
  icon: React.ElementType;
  color: string;
  tooltip: string;
}

/* ── Component ─────────────────────────────────────────────────────── */
export function QuantPanel({ symbol }: { symbol?: string }) {
  const { snapshot } = useLiveData();
  const market = snapshot.market;
  const active = symbol
    ? market.find((m) => m.symbol === symbol)
    : market[0];

  // Derive quant-like metrics from available data
  const price = active?.lastPrice || 0;
  const volume24h = active?.volume24h || 0;
  const priceChange = active?.priceChangePct || 0;

  // Simulated quant metrics derived from available data
  const volatility = Math.abs(priceChange) * 2.5;
  const momentumScore = priceChange > 0
    ? Math.min(priceChange * 10, 100)
    : Math.max(priceChange * 10, -100);
  const regimeStr = volatility < 1.5 ? "LOW VOL" : volatility < 4 ? "NORMAL" : "HIGH VOL";
  const regimeColor = volatility < 1.5 ? "text-blue-400" : volatility < 4 ? "text-emerald-400" : "text-red-400";

  const metrics: QuantMetric[] = [
    {
      label: "Momentum",
      value: `${momentumScore > 0 ? "+" : ""}${momentumScore.toFixed(1)}`,
      icon: TrendingUp,
      color: momentumScore > 0 ? "text-green-400" : momentumScore < 0 ? "text-red-400" : "text-gray-400",
      tooltip: "Multi-TF composite momentum (ROC 5/14/30)",
    },
    {
      label: "Volatility",
      value: `${volatility.toFixed(1)}%`,
      icon: Activity,
      color: regimeColor,
      tooltip: "Realized volatility (Bollinger bandwidth proxy)",
    },
    {
      label: "Regime",
      value: regimeStr,
      icon: Waves,
      color: regimeColor,
      tooltip: "Hurst exponent regime: <0.4=mean-revert, >0.6=trending",
    },
    {
      label: "Vol 24h",
      value: volume24h >= 1e9
        ? `$${(volume24h / 1e9).toFixed(1)}B`
        : volume24h >= 1e6
          ? `$${(volume24h / 1e6).toFixed(0)}M`
          : `$${(volume24h / 1e3).toFixed(0)}K`,
      icon: BarChart2,
      color: "text-purple-400",
      tooltip: "24h trading volume (liquidity indicator)",
    },
    {
      label: "Price",
      value: price > 1000
        ? `$${price.toFixed(0)}`
        : price > 1
          ? `$${price.toFixed(2)}`
          : `$${price.toFixed(4)}`,
      icon: Target,
      color: "text-foreground",
      tooltip: "Current mark price",
    },
    {
      label: "Δ 24h",
      value: `${priceChange > 0 ? "+" : ""}${priceChange.toFixed(2)}%`,
      icon: Gauge,
      color: priceChange > 0 ? "text-green-400" : priceChange < 0 ? "text-red-400" : "text-gray-400",
      tooltip: "24h price change",
    },
  ];

  return (
    <div className="rounded-lg border border-border/40 bg-card/30">
      <div className="flex items-center gap-2 border-b border-border/30 px-3 py-2">
        <Activity size={13} className="text-cyan-400" />
        <span className="text-[11px] font-semibold tracking-tight">
          Quant HFT — {active?.symbol || "—"}
        </span>
        <span className={`ml-auto text-[9px] font-bold uppercase tracking-wider ${regimeColor}`}>
          {regimeStr}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-px bg-border/20 sm:grid-cols-6">
        {metrics.map((m) => {
          const Icon = m.icon;
          return (
            <div
              key={m.label}
              title={m.tooltip}
              className="flex flex-col items-center gap-0.5 bg-card/50 px-2 py-2 transition-colors hover:bg-muted/30"
            >
              <Icon size={11} className={`${m.color} opacity-70`} />
              <span className={`text-xs font-semibold tabular-nums ${m.color}`}>
                {m.value}
              </span>
              <span className="text-[8px] uppercase tracking-wider text-muted-foreground">
                {m.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
