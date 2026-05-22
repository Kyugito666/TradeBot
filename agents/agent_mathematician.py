"""
[agent_mathematician.py]
=============
Agen statistik kuantitatif yang bertanggung jawab menghitung probabilitas arah harga
berdasarkan base rate historis, anomali volatilitas, dan mean reversion.

Agent: Mathematician
Role: Quantitative Statistics & Probability Edge
Dependencies: numpy, pandas, scipy
"""

import logging
import asyncio
import numpy as np
import pandas as pd
from dataclasses import dataclass
from scipy import stats

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class MathSignal:
    probability_up: float
    probability_down: float
    confidence: float
    anomaly_score: float
    regime: str
    bb_percent_b: float
    rsi: float
    z_score: float
    reasoning: str

class MathematicianAgent:
    def __init__(self, rsi_period: int = 14, bb_period: int = 20, bb_std: float = 2.0):
        self.rsi_period = rsi_period
        self.bb_period = bb_period
        self.bb_std = bb_std

    async def analyze(self, candles: pd.DataFrame) -> MathSignal:
        """
        Entry point asinkron. Meng-offload komputasi matematis ke thread terpisah
        agar tidak memblokir event loop utama (WebSocket/Order Execution).
        """
        return await asyncio.to_thread(self._run_analysis_sync, candles)

    def _run_analysis_sync(self, df: pd.DataFrame) -> MathSignal:
        """Eksekusi sinkron untuk semua kalkulasi statistik."""
        try:
            if df.empty or len(df) < max(self.rsi_period, self.bb_period, 50):
                raise ValueError("Data candle tidak cukup untuk analisis Math.")

            closes = df['close'].values
            highs = df['high'].values
            lows = df['low'].values

            # 1. RSI
            rsi_val = self._calculate_rsi(closes, self.rsi_period)

            # 2. Bollinger Bands Anomaly
            bb_upper, bb_lower, percent_b = self._bollinger_band_signal(closes, self.bb_period, self.bb_std)
            
            # Anomaly Score: seberapa jauh %B di luar batas [0, 1]
            anomaly_score = 0.0
            if percent_b > 1.0:
                anomaly_score = min(percent_b - 1.0, 1.0)
            elif percent_b < 0.0:
                anomaly_score = min(abs(percent_b), 1.0)

            # 3. Mean Reversion Z-Score
            z_score = self._mean_reversion_score(closes, period=50)

            # 4. Market Regime (ADX / Volatility Proxy)
            regime = self._detect_market_regime(highs, lows, closes)

            # 5. Probabilistic Edge (Base rate dari 200 candle terakhir)
            prob_up, prob_down = self._calculate_conditional_probability(closes)

            # 6. Bayesian Update (Contoh: RSI extreme meng-update base probability)
            # Likelihood up jika RSI oversold (< 30) tinggi, likelihood down jika overbought (> 70) tinggi
            if rsi_val < 30:
                prob_up = self._bayesian_probability_update(prob_up, 0.8, 0.2)
                prob_down = 1.0 - prob_up
            elif rsi_val > 70:
                prob_down = self._bayesian_probability_update(prob_down, 0.8, 0.2)
                prob_up = 1.0 - prob_down

            # Confidence scale (0-1) berdasarkan ekstremitas sinyal gabungan
            confidence = min(abs(z_score) / 3.0 + anomaly_score, 1.0)

            reasoning = (
                f"Regime: {regime}. RSI: {rsi_val:.1f}, Z-Score: {z_score:.2f}, "
                f"BB %B: {percent_b:.2f}. P(Up): {prob_up:.2%} P(Down): {prob_down:.2%}."
            )

            logger.info("[Mathematician] Analisis selesai | regime=%s P(up)=%.2f z_score=%.2f", regime, prob_up, z_score)

            return MathSignal(
                probability_up=round(prob_up, 4),
                probability_down=round(prob_down, 4),
                confidence=round(confidence, 4),
                anomaly_score=round(anomaly_score, 4),
                regime=regime,
                bb_percent_b=round(percent_b, 4),
                rsi=round(rsi_val, 2),
                z_score=round(z_score, 2),
                reasoning=reasoning
            )

        except Exception as e:
            logger.exception("[Mathematician] Kalkulasi gagal: %s", e)
            # Failsafe return
            return MathSignal(0.5, 0.5, 0.0, 0.0, "UNKNOWN", 0.5, 50.0, 0.0, "Math agent error.")

    def _calculate_rsi(self, closes: np.ndarray, period: int) -> float:
        deltas = np.diff(closes)
        seed = deltas[:period]
        up = seed[seed >= 0].sum() / period
        down = -seed[seed < 0].sum() / period
        
        if down == 0:
            return 100.0
            
        rs = up / down
        rsi = np.zeros_like(closes)
        rsi[:period] = 100. - 100. / (1. + rs)

        for i in range(period, len(closes)):
            delta = deltas[i - 1]
            upval = delta if delta > 0 else 0.
            downval = -delta if delta < 0 else 0.

            up = (up * (period - 1) + upval) / period
            down = (down * (period - 1) + downval) / period
            rs = up / down if down > 0 else 0
            rsi[i] = 100. - 100. / (1. + rs)

        return float(rsi[-1])

    def _bollinger_band_signal(self, closes: np.ndarray, period: int, k: float) -> tuple[float, float, float]:
        if len(closes) < period:
            return 0.0, 0.0, 0.5
        
        window = closes[-period:]
        sma = np.mean(window)
        std = np.std(window)
        upper = sma + (k * std)
        lower = sma - (k * std)
        current_price = closes[-1]
        
        if upper == lower:
            return upper, lower, 0.5
            
        percent_b = (current_price - lower) / (upper - lower)
        return float(upper), float(lower), float(percent_b)

    def _mean_reversion_score(self, closes: np.ndarray, period: int = 50) -> float:
        if len(closes) < period:
            period = len(closes)
        window = closes[-period:]
        mean = np.mean(window)
        std = np.std(window)
        if std == 0: return 0.0
        return float((closes[-1] - mean) / std)

    def _detect_market_regime(self, highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> str:
        """Simple proxy for regime detection using ATR and return distributions."""
        tr = np.maximum(highs[1:] - lows[1:], 
                        np.maximum(abs(highs[1:] - closes[:-1]), abs(lows[1:] - closes[:-1])))
        atr_current = np.mean(tr[-period:])
        atr_historical = np.mean(tr)
        
        returns = np.diff(closes) / closes[:-1]
        trend_proxy = np.sum(returns[-period:])
        
        if atr_current > atr_historical * 1.5:
            return "VOLATILE"
        elif trend_proxy > 0.02:
            return "TRENDING_UP"
        elif trend_proxy < -0.02:
            return "TRENDING_DOWN"
        else:
            return "RANGING"

    def _calculate_conditional_probability(self, closes: np.ndarray, lookback: int = 200, forward_n: int = 3) -> tuple[float, float]:
        if len(closes) < lookback + forward_n:
            return 0.5, 0.5
            
        window = closes[-lookback:]
        returns = np.diff(window)
        
        # Simple conditional edge: if last candle was red, what is prob next N are green?
        is_red = returns[:-forward_n] < 0
        future_returns = window[forward_n:] - window[:-forward_n]
        is_green_future = future_returns[1:] > 0
        
        # P(Up | Last is Red)
        conditions_met = np.sum(is_red)
        if conditions_met == 0:
            return 0.5, 0.5
            
        up_after_red = np.sum(is_green_future[is_red])
        prob_up = up_after_red / conditions_met
        return float(prob_up), float(1.0 - prob_up)

    def _bayesian_probability_update(self, prior: float, likelihood_event_given_up: float, likelihood_event_given_down: float) -> float:
        evidence = (likelihood_event_given_up * prior) + (likelihood_event_given_down * (1 - prior))
        if evidence == 0: return prior
        posterior = (likelihood_event_given_up * prior) / evidence
        return float(posterior)

if __name__ == "__main__":
    # Unit Test Sederhana
    logging.basicConfig(level=logging.INFO)
    agent = MathematicianAgent()
    dummy_data = pd.DataFrame({
        'open': np.random.randn(200).cumsum() + 100,
        'high': np.random.randn(200).cumsum() + 102,
        'low': np.random.randn(200).cumsum() + 98,
        'close': np.random.randn(200).cumsum() + 100,
        'volume': np.random.randint(10, 1000, 200)
    })
    
    result = asyncio.run(agent.analyze(dummy_data))
    print("\n[TEST RESULT] Math Signal:", result)