"""
Immutable, typed data models for the ingestion layer.

Design rationale:
- `frozen=True`: enforces immutability; these are value objects, not mutable state.
- `slots=True` (Python >=3.10): eliminates __dict__ per instance, reducing memory
  footprint by ~40% — critical when thousands of TickerUpdates flow through per second.
- Properties (mid, spread_bps, bias) are derived; computed on-access rather than stored,
  keeping the serialization contract clean for downstream queues.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True, slots=True)
class TickerUpdate:
    symbol: str
    bid: float
    ask: float
    timestamp: datetime
    exchange: str

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2.0

    @property
    def spread_bps(self) -> float:
        """Bid-ask spread in basis points. Used as a liquidity health signal."""
        if self.mid == 0:
            return 0.0
        return ((self.ask - self.bid) / self.mid) * 10_000.0


@dataclass(frozen=True, slots=True)
class OpenInterest:
    symbol: str
    oi: float           # Raw contracts / coin quantity
    oi_value: float     # Notional USD. 0.0 if mark price unavailable at fetch time.
    timestamp: datetime
    exchange: str


@dataclass(frozen=True, slots=True)
class WhaleRatio:
    symbol: str
    long_ratio: float       # Fraction of top-trader accounts net long  (0.0–1.0)
    short_ratio: float      # Fraction of top-trader accounts net short (0.0–1.0)
    long_short_ratio: float # Raw LSR: long_ratio / short_ratio
    timestamp: datetime
    exchange: str
    period: str             # Sampling window, e.g. "5m", "1h"

    @property
    def bias(self) -> str:
        """
        Coarse positioning label for logging and signal pre-filtering.
        Thresholds (±5%) are intentionally conservative to avoid noise labels.
        The Analytical Engine (Phase 2) will apply precise quantitative thresholds.
        """
        if self.long_short_ratio > 1.05:
            return "LONG_HEAVY"
        if self.long_short_ratio < 0.95:
            return "SHORT_HEAVY"
        return "NEUTRAL"
