import asyncio
import logging
import pandas as pd
from typing import Any, Optional
from dataclasses import dataclass

from analytical_engine.liquidation import LiquidationClusterEngine

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class LiquidationSignal:
    direction: str
    confidence: float
    profile: Optional[Any]

class LiquidatorAgent:
    def __init__(self, engine: LiquidationClusterEngine):
        """
        Agen spesialis pemburu likuiditas.
        engine: Instansiasi dari LiquidationClusterEngine.
        """
        self.engine = engine

    async def analyze(self, df: pd.DataFrame, oi: float, lsr: float, symbol: str) -> LiquidationSignal:
        """
        Mengonversi profil likuidasi statis menjadi sinyal trading terarah.
        Klaster likuidasi bertindak sebagai magnet harga.
        """
        if df.empty:
            return LiquidationSignal(direction="WAIT", confidence=0.0, profile=None)

        try:
            # Offload heavy computation ke thread terpisah untuk menghindari GIL blocking
            profile = await asyncio.to_thread(self.engine.build_profile, df, oi, lsr, symbol)
        except Exception as e:
            logger.error(f"[LiquidatorAgent] Gagal membangun profil likuidasi: {e}")
            return LiquidationSignal(direction="WAIT", confidence=0.0, profile=None)

        if profile is None:
            return LiquidationSignal(direction="WAIT", confidence=0.0, profile=None)

        current = profile.current_price
        atr = profile.atr

        # Klaster SHORT terdekat berada di ATAS harga saat ini -> Magnet harga naik (BUY)
        above_clusters = [c for c in profile.short_clusters if c.price > current]
        
        # Klaster LONG terdekat berada di BAWAH harga saat ini -> Magnet harga turun (SELL)
        below_clusters = [c for c in profile.long_clusters if c.price < current]

        # Temukan pusat klaster yang paling dekat dengan harga saat ini
        nearest_above = min(above_clusters, key=lambda c: c.price - current, default=None)
        nearest_below = min(below_clusters, key=lambda c: current - c.price, default=None)

        direction = "WAIT"
        confidence = 0.0

        # Aturan Jarak: Magnetik hanya berlaku jika klaster berada di dalam radius volatilitas (2x ATR)
        if nearest_above and (nearest_above.price - current) < (atr * 2.0):
            direction = "BUY"
            confidence = float(nearest_above.density_score)
        elif nearest_below and (current - nearest_below.price) < (atr * 2.0):
            direction = "SELL"
            confidence = float(nearest_below.density_score)

        return LiquidationSignal(
            direction=direction,
            confidence=confidence,
            profile=profile
        )