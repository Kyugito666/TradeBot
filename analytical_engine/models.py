"""
Phase 2 — Analytical Engine: Data Models
=========================================

Design rationale (consistent with Phase 1 data_ingestion/models.py):
- `frozen=True`  : immutability; these are value objects, not mutable state containers.
- `slots=True`   : ~40% memory reduction per instance (Python >= 3.10).
- Derived fields : (risk_reward, confidence) stored as-computed to keep serialisation clean.

Model hierarchy:
    LiquidationCluster  →  one price zone with estimated liquidation density
    ClusterProfile      →  full landscape: all clusters + ATR for a symbol snapshot
    AnalysisSignal      →  final evaluator output: Action + Entry/TP/SL + metadata
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum


# ---------------------------------------------------------------------------
# Enumerations
# ---------------------------------------------------------------------------

class Action(str, Enum):
    """
    Directional action emitted by the SignalEvaluator.

    BUY / SELL → a high-confidence setup was found.
    WAIT       → no edge detected; do not trade. Default safe state.
    """
    BUY  = "BUY"
    SELL = "SELL"
    WAIT = "WAIT"


class ClusterSide(str, Enum):
    """
    Which open position side gets liquidated when price reaches the cluster.

    LONG  → price dropped to this level → long positions hit liq price.
    SHORT → price rose  to this level → short positions hit liq price.
    """
    LONG  = "LONG"
    SHORT = "SHORT"


# ---------------------------------------------------------------------------
# Cluster primitives
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class LiquidationCluster:
    """
    A single estimated liquidation price zone.

    Attributes
    ----------
    price         : Central price of the histogram bin representing this cluster.
    estimated_oi  : Weighted OI (USD-notional proxy) allocated to this bin.
                    Not an exact figure — treat as a relative density weight.
    density_score : Normalised [0.0–1.0]. 1.0 = globally densest cluster found.
                    Used for TP selection and confidence scoring.
    side          : Which position side liquidates if price reaches `price`.
    leverage_peak : Modal leverage tier driving this cluster (informational;
                    Phase 4 Risk layer may use it for position sizing).
    """
    price:         float
    estimated_oi:  float
    density_score: float
    side:          ClusterSide
    leverage_peak: float


@dataclass(frozen=True, slots=True)
class ClusterProfile:
    """
    Complete liquidation landscape snapshot for one symbol.

    long_clusters  : Tuple of LONG-side clusters, sorted by price ascending.
                     Clusters below current_price are relevant for SELL signals (TP).
    short_clusters : Tuple of SHORT-side clusters, sorted by price ascending.
                     Clusters above current_price are relevant for BUY signals (TP).
    atr            : 14-period Wilder ATR at snapshot time. Used by evaluator
                     for SL buffering and entry micro-adjustment.
    """
    symbol:         str
    current_price:  float
    long_clusters:  tuple[LiquidationCluster, ...]
    short_clusters: tuple[LiquidationCluster, ...]
    atr:            float
    timestamp:      datetime


# ---------------------------------------------------------------------------
# Signal
# ---------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class AnalysisSignal:
    """
    Structured output from SignalEvaluator.

    Consumed by Phase 3 (Execution) and Phase 4 (Risk/Monitoring).

    Attributes
    ----------
    action      : BUY | SELL | WAIT
    entry       : Suggested limit-order entry price.
    take_profit : Target exit price at the liquidation cluster ahead.
    stop_loss   : Invalidation price (structural level + ATR buffer).
    risk_reward : |TP − entry| / |entry − SL|.  Filtered to >= 1.5 before emit.
    confidence  : Composite [0.0–1.0] score.
                  < 0.35 → speculative; 0.35–0.65 → moderate; > 0.65 → high.
    whale_bias  : Forwarded from WhaleRatio.bias ("LONG_HEAVY" | "SHORT_HEAVY" | "NEUTRAL").
    rationale   : Human-readable summary. Structured for logging / alerting pipelines.
    """
    symbol:       str
    action:       Action
    entry:        float
    take_profit:  float
    stop_loss:    float
    risk_reward:  float
    confidence:   float
    whale_bias:   str
    rationale:    str
    timestamp:    datetime
