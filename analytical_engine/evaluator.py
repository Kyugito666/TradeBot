"""
Phase 2 — Analytical Engine: Signal Evaluator
==============================================

Signal Generation Logic — The "Liquidity Magnet" Model
-------------------------------------------------------
The central thesis is that dense liquidation clusters attract price. Two forces
drive this empirically observed behaviour:

  1. Institutional stop-hunting: large players push price toward known cluster
     zones to trigger cascading forced liquidations, generating liquidity for
     their own entries/exits.
  2. Self-fulfilling cascade: once a cluster zone is breached, forced market-order
     selling (LONG clusters) or buying (SHORT clusters) amplifies the move,
     creating momentum that technical traders then follow.

Therefore:
  - SHORT liquidation clusters ABOVE current price → TP targets for BUY signals
    (price pumps up, force-liquidates shorts, momentum carries it to the cluster).
  - LONG  liquidation clusters BELOW current price → TP targets for SELL signals
    (price dumps down, force-liquidates longs, momentum carries it to the cluster).

Whale Positioning Gate
----------------------
LSR (Long/Short Ratio) from Phase 1 tells us which side currently dominates:
  - LSR > 1.05 (LONG_HEAVY) → majority positioned long → short squeeze risk is
    elevated; price has fuel to run UP into SHORT clusters → BUY bias.
  - LSR < 0.95 (SHORT_HEAVY) → majority positioned short → long squeeze risk is
    elevated; price has fuel to run DOWN into LONG clusters → SELL bias.
  - NEUTRAL → no directional edge from positioning alone → WAIT.

Entry Pricing
-------------
We don't chase market price. Entry is set slightly BETTER than current to
simulate a limit order:
  - BUY  entry = current_price − (ATR × pullback)
  - SELL entry = current_price + (ATR × pullback)

Stop Loss Placement
-------------------
SL anchors to the recent structural swing level (lowest-low / highest-high of
the prior 20 candles), buffered by half an ATR:
  - BUY  SL = swing_low  − (ATR × 0.5)
  - SELL SL = swing_high + (ATR × 0.5)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from .models import Action, AnalysisSignal, ClusterProfile, ClusterSide, LiquidationCluster

logger = logging.getLogger(__name__)

# Base constants (akan dioverride oleh trading_style)
SL_ATR_BUFFER       : float = 0.5    
SWING_LOOKBACK      : int   = 20     
MAX_CLUSTER_DIST_PCT: float = 0.05   
MIN_TP_DENSITY      : float = 0.30   

_W_LSR     : float = 0.40
_W_CLUSTER : float = 0.35
_W_RR      : float = 0.25


class SignalEvaluator:
    def __init__(self):
        # AI Insight Container
        self.latest_insight = {
            "timestamp": "-",
            "trend_state": "WAITING",
            "whale_bias": "-",
            "advice": "Menunggu siklus analisa pertama...",
            "signal_status": "WAIT"
        }

    def evaluate(
        self,
        profile: ClusterProfile,
        whale_lsr: float,
        whale_bias: str,
        candles: pd.DataFrame,
        trading_style: str = "sniper"
    ) -> AnalysisSignal:
        current = profile.current_price
        atr     = profile.atr

        # Setup Risk & Aggressiveness Berdasarkan Style
        if trading_style == "scalping":
            min_rr = 1.2
            entry_atr_pullback = 0.10
        else: # sniper
            min_rr = 1.5
            entry_atr_pullback = 0.25

        if atr < 1e-8:
            return self._wait(profile.symbol, current, whale_bias, "ATR ≈ 0 — flat or illiquid market")
        if whale_lsr <= 0:
            return self._wait(profile.symbol, current, whale_bias, f"Invalid LSR={whale_lsr:.4f}")

        # Analisa Price Action Dasar (Exhaustion & Whale Bait Guard)
        last_candle = candles.iloc[-1]
        body = abs(last_candle['close'] - last_candle['open'])
        upper_wick = last_candle['high'] - max(last_candle['open'], last_candle['close'])
        lower_wick = min(last_candle['open'], last_candle['close']) - last_candle['low']
        
        try:
            sma_10 = candles['close'].rolling(10).mean().iloc[-1]
        except:
            sma_10 = current

        # Deteksi pucuk (pump) atau dasar (dump) berdasarkan jarum penolakan
        is_pump_exhausted = (current > sma_10 * 1.005) and (upper_wick > body * 1.2)
        is_dump_exhausted = (current < sma_10 * 0.995) and (lower_wick > body * 1.2)

        # Default State
        insight_state = "NEUTRAL (Sideways/No Edge)"
        advice = "Sabar. Tidak ada dominasi arah yang jelas. Jangan paksakan entry."
        action = Action.WAIT
        signal_reason = "No Confluence"

        # Cek Arah Dominasi
        if whale_bias == "LONG_HEAVY":
            insight_state = "BULLISH BIAS (Cari Long)"
            advice = "Whale didominasi Long. Cari peluang BUY saat harga terkoreksi (pullback)."
            
            if is_pump_exhausted:
                insight_state = "⚠️ WHALE BAIT DETECTED (FAKE PUMP)"
                advice = f"BAHAYA! Harga nge-pump tapi ngebentuk jarum penolakan di pucuk ({current:.2f}). Market Maker sedang mancing retail. JANGAN LONG! Tunggu dump atau cari setup SHORT manual."
                signal_reason = "Bait Guard: Long Rejection di Pucuk"
            else:
                short_above = [c for c in profile.short_clusters if c.price > current and (c.price - current) / current <= MAX_CLUSTER_DIST_PCT]
                if short_above:
                    return self._process_signal(
                        Action.BUY, profile.symbol, current, atr, whale_lsr, whale_bias, 
                        short_above, candles, min_rr, entry_atr_pullback, "up"
                    )

        elif whale_bias == "SHORT_HEAVY":
            insight_state = "BEARISH BIAS (Cari Short)"
            advice = "Whale didominasi Short. Cari peluang SELL saat harga pantul ke atas (bounce)."
            
            if is_dump_exhausted:
                insight_state = "⚠️ WHALE BAIT DETECTED (FAKE DUMP)"
                advice = f"BAHAYA! Harga nge-dump tapi ngebentuk jarum penolakan di dasar ({current:.2f}). Market Maker mancing retail buat nyusul Short. JANGAN SHORT! Tunggu pantulan."
                signal_reason = "Bait Guard: Short Rejection di Dasar"
            else:
                long_below = [c for c in profile.long_clusters if c.price < current and (current - c.price) / current <= MAX_CLUSTER_DIST_PCT]
                if long_below:
                    return self._process_signal(
                        Action.SELL, profile.symbol, current, atr, whale_lsr, whale_bias, 
                        long_below, candles, min_rr, entry_atr_pullback, "down"
                    )

        # Update Live Insight sebelum me-return WAIT
        self.latest_insight = {
            "timestamp": datetime.now(tz=timezone.utc).strftime("%H:%M:%S") + " UTC",
            "trend_state": insight_state,
            "whale_bias": f"{whale_bias} (LSR: {whale_lsr:.2f})",
            "advice": advice,
            "signal_status": "WAIT (Skipped)"
        }
        return self._wait(profile.symbol, current, whale_bias, signal_reason)


    def _process_signal(self, action, symbol, current, atr, lsr, bias, clusters, candles, min_rr, pullback, direction):
        tp_cluster = self._select_tp(clusters, current, direction)
        tp = tp_cluster.price

        if action == Action.BUY:
            entry = max(current - (atr * pullback), current * 0.9990)
            swing = self._swing_low(candles)
            sl = (swing - (atr * SL_ATR_BUFFER)) if swing is not None else entry - (atr * 2.0)
            if sl >= entry: return self._wait(symbol, current, bias, "Invalid SL structure")
        else:
            entry = min(current + (atr * pullback), current * 1.0010)
            swing = self._swing_high(candles)
            sl = (swing + (atr * SL_ATR_BUFFER)) if swing is not None else entry + (atr * 2.0)
            if sl <= entry: return self._wait(symbol, current, bias, "Invalid SL structure")

        rr = self._calc_rr(entry, tp, sl, action)
        if rr < min_rr:
            self.latest_insight = {
                "timestamp": datetime.now(tz=timezone.utc).strftime("%H:%M:%S") + " UTC",
                "trend_state": f"VALID {action.value} SETUP",
                "whale_bias": bias,
                "advice": f"Ada sinyal {action.value}, tapi R:R ({rr:.2f}) kurang dari target minimum ({min_rr}). Bot skip. Boleh eksekusi manual jika yakin.",
                "signal_status": "SKIPPED (R:R Rendah)"
            }
            return self._wait(symbol, current, bias, f"R:R {rr:.2f} < {min_rr}")

        conf = self._confidence(lsr, tp_cluster.density_score, rr)
        rationale = f"Signal {action.value} | Target: {tp:.2f} | Entry: {entry:.2f} | SL: {sl:.2f} | R:R: {rr:.2f}"
        
        self.latest_insight = {
            "timestamp": datetime.now(tz=timezone.utc).strftime("%H:%M:%S") + " UTC",
            "trend_state": f"🔥 {action.value} SIGNAL FIRED",
            "whale_bias": bias,
            "advice": f"Bot mengeksekusi {action.value} di sekitar harga {entry:.2f}. Support/Resist terdekat (SL) di {sl:.2f} dan target likuidasi (TP) di {tp:.2f}.",
            "signal_status": f"{action.value} (Conf: {conf:.2f})"
        }

        logger.info("[SignalEvaluator] %s signal | %s", action.value, rationale)

        return AnalysisSignal(
            symbol=symbol, action=action, entry=round(entry, 2), take_profit=round(tp, 2),
            stop_loss=round(sl, 2), risk_reward=round(rr, 3), confidence=round(conf, 3),
            whale_bias=bias, rationale=rationale, timestamp=datetime.now(tz=timezone.utc)
        )


    @staticmethod
    def _select_tp(clusters: list[LiquidationCluster], current: float, direction: str) -> LiquidationCluster:
        qualified = [c for c in clusters if c.density_score >= MIN_TP_DENSITY]
        pool = qualified if qualified else clusters
        if direction == "up": return min(pool, key=lambda c: c.price)
        else: return max(pool, key=lambda c: c.price)


    @staticmethod
    def _swing_low(candles: pd.DataFrame) -> Optional[float]:
        subset = candles["low"].iloc[-(SWING_LOOKBACK + 1):-1]
        return float(subset.min()) if len(subset) > 0 else None


    @staticmethod
    def _swing_high(candles: pd.DataFrame) -> Optional[float]:
        subset = candles["high"].iloc[-(SWING_LOOKBACK + 1):-1]
        return float(subset.max()) if len(subset) > 0 else None


    @staticmethod
    def _calc_rr(entry: float, tp: float, sl: float, action: Action) -> float:
        if action == Action.BUY:
            reward = tp - entry
            risk   = entry - sl
        else:
            reward = entry - tp
            risk   = sl - entry

        if risk <= 0: return 0.0
        return reward / risk


    @staticmethod
    def _confidence(lsr: float, cluster_density: float, rr: float) -> float:
        lsr_score  = min(abs(lsr - 1.0) / 0.5, 1.0)
        rr_score   = min(rr / 3.0, 1.0)
        return _W_LSR * lsr_score + _W_CLUSTER * cluster_density + _W_RR * rr_score


    def _wait(self, symbol: str, price: float, bias: str, reason: str) -> AnalysisSignal:
        logger.debug("[SignalEvaluator] WAIT | %s | %s", symbol, reason)
        return AnalysisSignal(
            symbol=symbol, action=Action.WAIT, entry=price, take_profit=price,
            stop_loss=price, risk_reward=0.0, confidence=0.0, whale_bias=bias,
            rationale=f"WAIT — {reason}", timestamp=datetime.now(tz=timezone.utc)
        )