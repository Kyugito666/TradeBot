"use client";

import { useState, useEffect, useCallback } from "react";

export interface ParquetFileInfo {
  name: string;
  size_bytes: number;
  size_mb: string;
}

export interface BigDataStats {
  total_ticks_written: number;
  buffer_pending: Record<string, number>;
  parquet_files: ParquetFileInfo[];
  total_files: number;
  total_storage_mb: string;
  ticks_path: string;
}

export interface AgentTrainingStatus {
  specialty: string;
  total_trades: number;
  win_rate: number;
  win_streak: number;
  loss_streak: number;
  pnl_r: number;
  graduated: boolean;
}

export function useBigData(refreshInterval = 15000) {
  const [stats, setStats] = useState<BigDataStats | null>(null);
  const [agentStatus, setAgentStatus] = useState<Record<string, AgentTrainingStatus>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      // Route through Next.js API proxy (avoids CORS / WSL port issues)
      const res = await fetch("/api/bigdata");
      if (res.ok) {
        const data = await res.json();
        if (data.stats) setStats(data.stats);
        if (data.agents && Object.keys(data.agents).length > 0) setAgentStatus(data.agents);
      }
      setError(null);
    } catch (e: any) {
      setError(e.message || "Failed to fetch BigData stats");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    const id = setInterval(fetchStats, refreshInterval);
    return () => clearInterval(id);
  }, [fetchStats, refreshInterval]);

  const triggerTrainAll = useCallback(async () => {
    try {
      const res = await fetch("/api/bigdata/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeframe: "1h", atr_mult: 2.0, rr: 2.0 }),
      });
      return await res.json();
    } catch {
      return { status: "error", message: "Failed to connect to Python ML Engine" };
    }
  }, []);

  return { stats, agentStatus, loading, error, refresh: fetchStats, triggerTrainAll };
}
