import logging
import numpy as np
import pandas as pd
from typing import Tuple
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class PhysicsSignal:
    direction: str
    confidence: float
    volatility_crisis: bool
    # ENHANCEMENT #1: Output GBM sekarang dapat diakses oleh ConsensusEngine
    gbm_p5: float
    gbm_p50: float
    gbm_p95: float
    gbm_upside_bias: float

class PhysicistAgent:
    def __init__(self, gbm_simulations: int = 1000, gbm_horizon: int = 24):
        self.gbm_simulations = gbm_simulations
        self.gbm_horizon = gbm_horizon

    async def analyze(self, df: pd.DataFrame, current_price: float) -> PhysicsSignal:
        """Menganalisis pergerakan harga menggunakan model stochastics dan fisika statistik."""
        closes = df['close'].values
        
        # 1. Deteksi Krisis Volatilitas (VETO Condition)
        # Sederhananya, jika stdev melonjak melebihi threshold historis ekstrem
        returns = np.diff(closes) / closes[:-1]
        volatility = np.std(returns[-20:])
        historical_vol = np.std(returns)
        vol_crisis = volatility > (historical_vol * 3.0) 
        
        # 2. Simulasi GBM (Geometric Brownian Motion)
        p5, p50, p95 = self._gbm_price_distribution(current_price, returns)
        
        # 3. Kalkulasi Upside Bias
        spread = p95 - p5
        if spread > 1e-8: # Proteksi div-by-zero
            gbm_upside_bias = (p95 - current_price) / spread
        else:
            gbm_upside_bias = 0.5
            
        # 4. Penentuan Arah Dasar
        direction = "WAIT"
        confidence = 0.5
        
        if gbm_upside_bias > 0.6:
            direction = "BUY"
            confidence = min(0.95, 0.4 + (gbm_upside_bias - 0.5))
        elif gbm_upside_bias < 0.4:
            direction = "SELL"
            confidence = min(0.95, 0.4 + (0.5 - gbm_upside_bias))
            
        if vol_crisis:
            logger.warning("[Physicist] Volatility crisis terdeteksi. Memaksa sinyal WAIT.")
            direction = "WAIT"
            confidence = 0.0

        return PhysicsSignal(
            direction=direction,
            confidence=confidence,
            volatility_crisis=vol_crisis,
            gbm_p5=float(p5),
            gbm_p50=float(p50),
            gbm_p95=float(p95),
            gbm_upside_bias=float(gbm_upside_bias)
        )

    def _gbm_price_distribution(self, current_price: float, returns: np.ndarray) -> Tuple[float, float, float]:
        """Menghasilkan proyeksi distribusi harga menggunakan model GBM."""
        mu = np.mean(returns)
        sigma = np.std(returns)
        
        dt = 1
        paths = np.zeros((self.gbm_horizon, self.gbm_simulations))
        paths[0] = current_price
        
        # Vektorisasi simulasi untuk performa C-level via NumPy
        for t in range(1, self.gbm_horizon):
            z = np.random.standard_normal(self.gbm_simulations)
            paths[t] = paths[t-1] * np.exp((mu - 0.5 * sigma**2) * dt + sigma * np.sqrt(dt) * z)
            
        final_prices = paths[-1]
        
        return (
            np.percentile(final_prices, 5), 
            np.percentile(final_prices, 50), 
            np.percentile(final_prices, 95)
        )