"use client";

import React, { useState } from "react";
import {
  Database, HardDrive, Activity, Zap, GraduationCap, AlertTriangle,
  RefreshCw, Play, ChevronDown, ChevronUp
} from "lucide-react";
import { useBigData } from "@/hooks/use-bigdata";

/* ── Helpers ─────────────────────────────────────────────────────────── */
function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/* ── Sub-components ──────────────────────────────────────────────────── */
function StatCard({ icon: Icon, label, value, sub, color = "text-foreground" }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-card/60 px-3.5 py-2.5">
      <div className={`rounded-md bg-muted/50 p-1.5 ${color}`}>
        <Icon size={14} />
      </div>
      <div className="min-w-0">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`text-sm font-semibold tabular-nums ${color}`}>{value}</p>
        {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

/* ── Main Component ──────────────────────────────────────────────────── */
export default function BigDataPanel() {
  const { stats, agentStatus, loading, triggerTrainAll, refresh } = useBigData(15000);
  const [showFiles, setShowFiles] = useState(false);
  const [showAgents, setShowAgents] = useState(true);
  const [training, setTraining] = useState(false);

  const handleTrain = async () => {
    setTraining(true);
    await triggerTrainAll();
    setTimeout(() => { setTraining(false); refresh(); }, 2000);
  };

  const agents = Object.entries(agentStatus);
  const graduated = agents.filter(([, s]) => s.graduated).length;
  const totalBuffered = stats ? Object.values(stats.buffer_pending).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="space-y-3">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database size={16} className="text-cyan-400" />
          <h3 className="text-sm font-semibold tracking-tight">BigData Pipeline</h3>
          {loading && <RefreshCw size={12} className="animate-spin text-muted-foreground" />}
        </div>
        <button
          onClick={refresh}
          className="rounded-md border border-border/50 p-1.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* ── Stat Cards ── */}
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <StatCard
          icon={Zap}
          label="Ticks Written"
          value={stats ? formatNumber(stats.total_ticks_written) : "—"}
          color="text-amber-400"
        />
        <StatCard
          icon={Activity}
          label="Buffer Pending"
          value={formatNumber(totalBuffered)}
          sub={stats ? `${Object.keys(stats.buffer_pending).length} symbols` : ""}
          color="text-cyan-400"
        />
        <StatCard
          icon={HardDrive}
          label="Storage"
          value={stats ? `${stats.total_storage_mb} MB` : "—"}
          sub={stats ? `${stats.total_files} files` : ""}
          color="text-emerald-400"
        />
        <StatCard
          icon={GraduationCap}
          label="Agents Graduated"
          value={`${graduated}/${agents.length || 14}`}
          color={graduated > 0 ? "text-green-400" : "text-orange-400"}
        />
      </div>

      {/* ── Offline State ── */}
      {!loading && !stats && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-6">
          <AlertTriangle size={20} className="text-amber-400" />
          <p className="text-xs font-medium text-amber-400">Engine Offline</p>
          <p className="text-[11px] text-muted-foreground text-center max-w-xs">
            BigData pipeline requires the Rust Brain (port 8080) and Python ML Engine (port 5000)
            to be running. Start the bot with <code className="text-foreground">./start_bot.sh</code>
          </p>
        </div>
      )}

      {/* ── Parquet Files (Collapsible) ── */}
      {stats && stats.parquet_files.length > 0 && (
        <div className="rounded-lg border border-border/40 bg-card/40">
          <button
            onClick={() => setShowFiles(!showFiles)}
            className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>Parquet Files ({stats.total_files})</span>
            {showFiles ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showFiles && (
            <div className="max-h-40 overflow-y-auto border-t border-border/30 px-3 py-1.5">
              {stats.parquet_files.map((f, i) => (
                <div key={i} className="flex items-center justify-between py-0.5 text-[10px]">
                  <span className="truncate text-muted-foreground">{f.name}</span>
                  <span className="ml-2 tabular-nums text-foreground/70">{f.size_mb} MB</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Agent Training Status (Collapsible) ── */}
      {agents.length > 0 && (
        <div className="rounded-lg border border-border/40 bg-card/40">
          <button
            onClick={() => setShowAgents(!showAgents)}
            className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <span>Military Tatar — Agent Status ({agents.length})</span>
            {showAgents ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showAgents && (
            <>
              <div className="overflow-x-auto border-t border-border/30">
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="border-b border-border/20 text-muted-foreground">
                      <th className="px-3 py-1.5 text-left font-medium">Agent</th>
                      <th className="px-2 py-1.5 text-left font-medium">Specialty</th>
                      <th className="px-2 py-1.5 text-right font-medium">Trades</th>
                      <th className="px-2 py-1.5 text-right font-medium">WR%</th>
                      <th className="px-2 py-1.5 text-right font-medium">PnL R</th>
                      <th className="px-2 py-1.5 text-center font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents
                      .sort(([, a], [, b]) => b.win_rate - a.win_rate)
                      .map(([id, s]) => (
                        <tr key={id} className="border-b border-border/10 transition-colors hover:bg-muted/20">
                          <td className="px-3 py-1.5 font-medium text-foreground">{id}</td>
                          <td className="px-2 py-1.5 text-muted-foreground">{s.specialty}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{s.total_trades}</td>
                          <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${
                            s.win_rate >= 60 ? "text-green-400" :
                            s.win_rate >= 45 ? "text-amber-400" : "text-red-400"
                          }`}>
                            {s.win_rate.toFixed(1)}%
                          </td>
                          <td className={`px-2 py-1.5 text-right tabular-nums ${
                            s.pnl_r >= 0 ? "text-green-400" : "text-red-400"
                          }`}>
                            {s.pnl_r >= 0 ? "+" : ""}{s.pnl_r.toFixed(1)}R
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            {s.graduated ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[9px] font-semibold text-green-400">
                                <GraduationCap size={9} /> LIVE
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/10 px-2 py-0.5 text-[9px] font-semibold text-orange-400">
                                <AlertTriangle size={9} /> TRAINING
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-end border-t border-border/20 px-3 py-2">
                <button
                  onClick={handleTrain}
                  disabled={training}
                  className="flex items-center gap-1.5 rounded-md bg-cyan-600/80 px-3 py-1.5 text-[10px] font-semibold text-white transition-colors hover:bg-cyan-500 disabled:opacity-50"
                >
                  {training ? <RefreshCw size={10} className="animate-spin" /> : <Play size={10} />}
                  {training ? "Training..." : "Train All Agents"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
