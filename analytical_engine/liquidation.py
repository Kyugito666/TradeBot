"""
Phase 2 — Analytical Engine: Liquidation Cluster Estimation
=============================================================

Mathematical Model
------------------
Direct liquidation heatmap feeds (e.g. CoinGlass, Coinalyze) are proprietary
and gated behind paid APIs. This engine **estimates** cluster density from
publicly available data (OHLCV + OI snapshot) using the following model:

1. OI Distribution Assumption
   Market microstructure theory: trading volume is a proxy for position-opening
   activity. We allocate total OI proportionally to each candle's volume:

       OI_candle_i  =  OI_total  ×  (volume_i / Σ volume_j)

   The VWAP of each candle — (H + L + C) / 3 — serves as the representative
   entry price for positions opened during that candle.

2. Liquidation Price Formula  (cross-margin, Tier 1 bracket)
   For a position opened at entry price P with leverage L:

       Long  liq price  =  P × (1 − 1/L + MMR)       … price falls to here
       Short liq price  =  P × (1 + 1/L − MMR)       … price rises to here

   where MMR (Maintenance Margin Rate) ≈ 0.4% for USDM perpetuals Tier 1.

3. Leverage Distribution
   Real exchange leverage usage follows a roughly log-normal distribution.
   We approximate it with discrete empirical weights derived from Binance and
   Bybit public statistics:

       Tiers  : [2×,  5×,  10×, 20×, 25×,  50×, 100×]
       Weights: [4%,  12%, 30%, 28%, 12%,  9%,  5%  ]

   10× and 20× account for ~58% of OI — consistent with reported exchange data.

4. Cluster Density Construction
   All (entry, leverage_tier) pairs produce an estimated liq price. These prices
   are placed into a weighted histogram (bin width = 0.1% of current price) with
   their allocated OI as weights. The histogram is then Gaussian-smoothed to
   produce a continuous density surface. Local maxima of this surface are the
   **liquidation clusters** — price zones of concentrated forced-exit risk.

5. Cluster Interpretation
   - SHORT clusters (above current price): if price reaches them, short positions
     are force-bought → cascading upward pressure.
   - LONG  clusters (below current price): if price reaches them, long positions
     are force-sold → cascading downward pressure.

   Dense clusters act as both magnets (institutional/algorithmic stop-hunting)
   and momentum accelerators (cascade liquidations).

Edge Cases Handled
------------------
- Insufficient candles (< 20) → returns None
- Zero volume or OI         → returns None
- Non-positive close price   → returns None
- Empty histogram peaks      → falls back to global argmax
- All-same-price candles (ATR = 0) → ATR returned as-is; evaluator handles
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from .models import ClusterProfile, ClusterSide, LiquidationCluster

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Leverage distribution constants
# ---------------------------------------------------------------------------
# Empirical discrete approximation of exchange leverage usage.
_LEVERAGE_TIERS   = np.array([2.0,  5.0,  10.0, 20.0, 25.0,  50.0, 100.0])
_LEVERAGE_WEIGHTS = np.array([0.04, 0.12, 0.30, 0.28, 0.12,  0.09, 0.05])

# Binance USDM / Bybit Linear Tier-1 maintenance margin rate.
# Increases for higher notional brackets — we use Tier 1 as conservative estimate.
_MAINTENANCE_MARGIN_RATE: float = 0.004   # 0.4%

# ---------------------------------------------------------------------------
# Engine tuning constants
# ---------------------------------------------------------------------------
_BIN_WIDTH_PCT    : float = 0.001   # Each histogram bin = 0.1% of current price
_MIN_CANDLES      : int   = 20      # Minimum candles for a statistically meaningful profile
_TOP_N_CLUSTERS   : int   = 8       # Max clusters returned per side
_SMOOTH_SIGMA     : float = 2.0     # Gaussian kernel σ in bins; controls cluster width
_MIN_DENSITY_FRAC : float = 0.05    # Prune clusters below 5% of peak density (noise filter)


class LiquidationClusterEngine:
    """
    Builds a ClusterProfile from OHLCV candles + OI snapshot.

    Stateless — all configuration via constructor. Safe to share across coroutines.

    Usage
    -----
        engine  = LiquidationClusterEngine()
        profile = engine.build_profile(candles_df, oi_contracts, lsr, "BTCUSDT")
    """

    def __init__(
        self,
        smooth_sigma: float = _SMOOTH_SIGMA,
        top_n:        int   = _TOP_N_CLUSTERS,
        bin_width_pct:float = _BIN_WIDTH_PCT,
    ) -> None:
        self._smooth_sigma  = smooth_sigma
        self._top_n         = top_n
        self._bin_width_pct = bin_width_pct

    # -----------------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------------

    def build_profile(
        self,
        candles:      pd.DataFrame,
        oi_contracts: float,
        lsr:          float,
        symbol:       str,
    ) -> Optional[ClusterProfile]:
        """
        Construct a full ClusterProfile from OHLCV + Open Interest.

        Args:
            candles      : DataFrame[open, high, low, close, volume] with DatetimeIndex (UTC).
                           Use at least 100 candles for a stable distribution.
                           More candles → wider lookback → more historical OI allocation.
            oi_contracts : Total open interest in contracts (base asset units).
                           Converted to USD notional internally: oi_usd = oi_contracts × close[-1].
            lsr          : Long/short ratio (whale.long_short_ratio from Phase 1).
                           Used to split OI between long and short participants.
            symbol       : Symbol string for the returned ClusterProfile.

        Returns:
            ClusterProfile, or None if data is insufficient / degenerate.
        """
        # --- Validation ---
        if len(candles) < _MIN_CANDLES:
            logger.warning("[LiqEngine:%s] Insufficient candles: %d < %d",
                           symbol, len(candles), _MIN_CANDLES)
            return None

        missing = {"open", "high", "low", "close", "volume"} - set(candles.columns)
        if missing:
            logger.error("[LiqEngine:%s] Missing columns: %s", symbol, missing)
            return None

        if candles["volume"].sum() <= 0 or oi_contracts <= 0:
            logger.error("[LiqEngine:%s] Zero volume or OI — skipping.", symbol)
            return None

        current_price: float = float(candles["close"].iloc[-1])
        if current_price <= 0:
            logger.error("[LiqEngine:%s] Non-positive close price: %.6f", symbol, current_price)
            return None

        # Convert OI to USD notional using current mark price proxy
        oi_usd: float = oi_contracts * current_price

        # Guard against degenerate LSR values (division-by-zero risk)
        safe_lsr = max(lsr, 1e-6)

        # --- Core computation ---
        atr = self._compute_atr(candles)

        long_px, long_w, short_px, short_w = self._build_liq_distributions(
            candles, oi_usd, safe_lsr
        )

        long_clusters  = self._find_clusters(long_px,  long_w,  current_price, ClusterSide.LONG)
        short_clusters = self._find_clusters(short_px, short_w, current_price, ClusterSide.SHORT)

        return ClusterProfile(
            symbol=symbol,
            current_price=current_price,
            long_clusters=tuple(sorted(long_clusters,  key=lambda c: c.price)),
            short_clusters=tuple(sorted(short_clusters, key=lambda c: c.price)),
            atr=atr,
            timestamp=datetime.now(tz=timezone.utc),
        )

    # -----------------------------------------------------------------------
    # ATR computation
    # -----------------------------------------------------------------------

    @staticmethod
    def _compute_atr(df: pd.DataFrame, period: int = 14) -> float:
        """
        Wilder 14-period ATR.

        Uses the Wilder smoothing (EMA with α = 1/period) rather than simple
        moving average — this is the standard in trading systems and matches
        what most execution platforms report.

        Returns 0.0 if insufficient data rather than raising.
        """
        high  = df["high"].values.astype(float)
        low   = df["low"].values.astype(float)
        close = df["close"].values.astype(float)

        if len(close) < 2:
            return 0.0

        # True Range components (vectorised, no loop)
        hl  = high[1:]  - low[1:]
        hpc = np.abs(high[1:] - close[:-1])
        lpc = np.abs(low[1:]  - close[:-1])
        tr  = np.maximum(hl, np.maximum(hpc, lpc))

        if len(tr) == 0:
            return 0.0

        # Seed with simple mean of first `period` TRs, then Wilder smooth
        seed_n  = min(period, len(tr))
        atr_val = tr[:seed_n].mean()
        alpha   = 1.0 / period

        for i in range(seed_n, len(tr)):
            atr_val = atr_val * (1.0 - alpha) + tr[i] * alpha

        return float(atr_val)

    # -----------------------------------------------------------------------
    # Liquidation price distribution builder
    # -----------------------------------------------------------------------

    @staticmethod
    def _build_liq_distributions(
        candles: pd.DataFrame,
        oi_usd:  float,
        lsr:     float,
    ) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """
        Returns (long_prices, long_weights, short_prices, short_weights).

        For every (candle × leverage_tier) pair, compute:
            - Where long  positions opened at candle_vwap / lev would liquidate
            - Where short positions opened at candle_vwap / lev would liquidate

        OI split between longs and shorts follows the whale LSR:
            long_frac  = lsr / (1 + lsr)
            short_frac = 1 − long_frac

        Vectorised with NumPy broadcasting for O(n_candles × n_tiers) efficiency.
        """
        volumes     = candles["volume"].values.astype(float)
        vol_weights = volumes / volumes.sum()                    # shape: (n,)

        # VWAP proxy: simple (H + L + C) / 3 per candle
        vwap = (
            candles["high"].values +
            candles["low"].values  +
            candles["close"].values
        ).astype(float) / 3.0                                   # shape: (n,)

        long_frac  = lsr / (1.0 + lsr)
        short_frac = 1.0 - long_frac

        # Broadcast: vwap[n, 1] × (1 ± 1/lev)[1, k] → (n, k) matrix of liq prices
        lev     = _LEVERAGE_TIERS[np.newaxis, :]                # shape: (1, k)
        lev_w   = _LEVERAGE_WEIGHTS[np.newaxis, :]              # shape: (1, k)
        vwap_2d = vwap[:, np.newaxis]                           # shape: (n, 1)

        long_liq_mat  = vwap_2d * (1.0 - 1.0 / lev + _MAINTENANCE_MARGIN_RATE)  # (n, k)
        short_liq_mat = vwap_2d * (1.0 + 1.0 / lev - _MAINTENANCE_MARGIN_RATE)  # (n, k)

        # OI per (candle, lev): oi_usd × vol_weight_i × lev_weight_j
        oi_per_candle  = oi_usd * vol_weights[:, np.newaxis]    # (n, 1)
        weight_mat     = oi_per_candle * lev_w                   # (n, k)

        long_w  = (weight_mat * long_frac).ravel()
        short_w = (weight_mat * short_frac).ravel()

        return long_liq_mat.ravel(), long_w, short_liq_mat.ravel(), short_w

    # -----------------------------------------------------------------------
    # Peak detection and cluster construction
    # -----------------------------------------------------------------------

    def _find_clusters(
        self,
        prices:        np.ndarray,
        weights:       np.ndarray,
        current_price: float,
        side:          ClusterSide,
    ) -> list[LiquidationCluster]:
        """
        Build a Gaussian-smoothed weighted histogram and detect local maxima.

        Steps:
          1. Bin liquidation prices into a fine-grained histogram (0.1%-wide bins).
          2. Smooth with Gaussian kernel (σ = 2 bins ≈ 0.2% price range).
          3. Find local maxima (peaks) of the smoothed density.
          4. Prune sub-5% peaks, normalise, return top-N LiquidationCluster objects.
        """
        if len(prices) == 0 or weights.sum() == 0:
            return []

        # Adaptive bin width anchored to current price
        bin_w     = current_price * self._bin_width_pct
        p_min     = float(prices.min()) * 0.995
        p_max     = float(prices.max()) * 1.005
        bin_edges = np.arange(p_min, p_max + bin_w, bin_w)

        if len(bin_edges) < 4:
            return []

        hist, edges = np.histogram(prices, bins=bin_edges, weights=weights)
        centers     = (edges[:-1] + edges[1:]) / 2.0

        # Gaussian smoothing (manual convolution — avoids scipy dependency)
        smoothed = self._gaussian_smooth(hist, sigma=self._smooth_sigma)

        # Local maxima detection
        peak_idx = self._find_peaks(smoothed)
        if len(peak_idx) == 0:
            peak_idx = np.array([int(np.argmax(smoothed))], dtype=int)

        max_density = smoothed[peak_idx].max()
        if max_density <= 0:
            return []

        # Normalise and filter
        clusters: list[LiquidationCluster] = []
        for idx in peak_idx:
            norm_density = float(smoothed[idx] / max_density)
            if norm_density < _MIN_DENSITY_FRAC:
                continue

            clusters.append(LiquidationCluster(
                price=float(centers[idx]),
                estimated_oi=float(smoothed[idx]),
                density_score=norm_density,
                side=side,
                leverage_peak=float(_LEVERAGE_TIERS[np.argmax(_LEVERAGE_WEIGHTS)]),
            ))

        # Return top-N by density
        clusters.sort(key=lambda c: c.density_score, reverse=True)
        return clusters[:self._top_n]

    # -----------------------------------------------------------------------
    # Signal processing utilities (no scipy dependency)
    # -----------------------------------------------------------------------

    @staticmethod
    def _gaussian_smooth(arr: np.ndarray, sigma: float) -> np.ndarray:
        """
        1D Gaussian convolution equivalent to scipy.ndimage.gaussian_filter1d.

        Kernel radius = 3σ (standard truncation). Mode='same' preserves array length.
        Manual implementation avoids the scipy dependency while maintaining O(n·k)
        complexity where k = 2⌊3σ⌋ + 1 (small constant for typical σ values).
        """
        if sigma <= 0:
            return arr.copy().astype(float)
        radius   = max(1, int(3.0 * sigma))
        x        = np.arange(-radius, radius + 1, dtype=float)
        kernel   = np.exp(-0.5 * (x / sigma) ** 2)
        kernel  /= kernel.sum()
        return np.convolve(arr.astype(float), kernel, mode="same")

    @staticmethod
    def _find_peaks(arr: np.ndarray) -> np.ndarray:
        """
        Detect strict local maxima: points strictly greater than both neighbours.

        Returns indices into arr. Returns empty array if arr has fewer than 3 elements.
        """
        if len(arr) < 3:
            return np.array([], dtype=int)
        left_gt  = arr[1:-1] > arr[:-2]
        right_gt = arr[1:-1] > arr[2:]
        return np.where(left_gt & right_gt)[0] + 1   # +1 corrects for slice offset
