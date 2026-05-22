"""
[agent_physicist.py]
=============
Agen yang memisahkan sinyal murni (tren) dari noise pasar. Menggunakan teknik
fisika seperti Fast Fourier Transform (FFT) dan Kalman Filter.

Agent: Physicist
Role: Signal Processing & Noise Cancellation
Dependencies: numpy, pandas
"""

import logging
import asyncio
import numpy as np
import pandas as pd
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class PhysicsSignal:
    trend_direction: str
    trend_strength: float
    noise_ratio: float
    volatility_regime: str
    kalman_velocity: float
    is_false_breakout: bool
    dominant_cycle: int
    reasoning: str

class PhysicistAgent:
    def __init__(self, fft_cutoff_fraction: float = 0.1):
        self.fft_cutoff = fft_cutoff_fraction

    async def analyze(self, candles: pd.DataFrame) -> PhysicsSignal:
        """
        Membungkus komputasi matriks/Numpy (FFT, Kalman) di thread terpisah.
        """
        return await asyncio.to_thread(self._run_analysis_sync, candles)

    def _run_analysis_sync(self, df: pd.DataFrame) -> PhysicsSignal:
        try:
            if df.empty or len(df) < 100:
                raise ValueError("Data tidak cukup untuk komputasi Physics (butuh >100 candle).")

            closes = df['close'].values
            opens = df['open'].values
            highs = df['high'].values
            lows = df['low'].values

            # 1. FFT De-noising & Dominant Cycle
            trend_line, noise_ratio, dominant_cycle = self._fft_trend_extraction(closes, self.fft_cutoff)
            
            # Hitung slope dari trend FFT
            fft_slope = trend_line[-1] - trend_line[-5]
            trend_dir = "UP" if fft_slope > 0 else ("DOWN" if fft_slope < 0 else "FLAT")
            trend_strength = min(abs(fft_slope) / (np.mean(closes[-5:]) * 0.01), 1.0) # Normalisasi kekuatan

            # 2. Kalman Filter Velocity
            _, kalman_velocity = self._kalman_filter_price(closes)

            # 3. Volatility Regime
            vol_regime = self._volatility_regime(highs, lows, closes)

            # 4. False Breakout Detection (Candle terakhir)
            tr = max(highs[-1] - lows[-1], abs(highs[-1] - closes[-2]), abs(lows[-1] - closes[-2])) if len(closes)>1 else (highs[-1]-lows[-1])
            false_bo = self._detect_false_breakout(opens[-1], highs[-1], lows[-1], closes[-1], tr)
            is_false_breakout = (false_bo in ["FALSE_UP", "FALSE_DOWN"])

            # 5. GBM Simulation Check (Optional logging insight)
            p5, p50, p95 = self._gbm_price_distribution(closes[-1], closes)
            logger.debug("[Physicist] GBM 10-step projections: p5=%.2f, median=%.2f, p95=%.2f", p5, p50, p95)

            reasoning = (
                f"Noise: {noise_ratio:.2%}. Kalman Vel: {kalman_velocity:.4f}. "
                f"FFT Cycle: {dominant_cycle} candles. False Breakout: {false_bo}."
            )

            logger.info("[Physicist] Analisis selesai | trend=%s noise=%.2f velocity=%.2f", trend_dir, noise_ratio, kalman_velocity)

            return PhysicsSignal(
                trend_direction=trend_dir,
                trend_strength=round(float(trend_strength), 4),
                noise_ratio=round(float(noise_ratio), 4),
                volatility_regime=vol_regime,
                kalman_velocity=round(float(kalman_velocity), 4),
                is_false_breakout=is_false_breakout,
                dominant_cycle=dominant_cycle,
                reasoning=reasoning
            )

        except Exception as e:
            logger.exception("[Physicist] Kalkulasi gagal: %s", e)
            return PhysicsSignal("FLAT", 0.0, 1.0, "UNKNOWN", 0.0, False, 0, "Physics agent error.")

    def _fft_trend_extraction(self, closes: np.ndarray, cutoff_fraction: float) -> tuple[np.ndarray, float, int]:
        n = len(closes)
        fft_result = np.fft.fft(closes)
        freqs = np.fft.fftfreq(n)
        
        # Filter frekuensi tinggi (noise)
        fft_filtered = fft_result.copy()
        high_freq_indices = np.abs(freqs) > cutoff_fraction
        fft_filtered[high_freq_indices] = 0
        
        trend = np.real(np.fft.ifft(fft_filtered))
        
        signal_power = np.sum(np.abs(fft_result[:n//2])**2)
        noise_power = np.sum(np.abs(fft_result[high_freq_indices])**2)
        noise_ratio = noise_power / (signal_power + 1e-9)

        # Cari frekuensi dominan (cycle) dari komponen yang tidak di-filter
        magnitudes = np.abs(fft_result[:n//2])
        # Skip DC component (index 0)
        dominant_freq_index = np.argmax(magnitudes[1:]) + 1
        dominant_cycle = int(n / dominant_freq_index) if dominant_freq_index > 0 else 0

        return trend, float(noise_ratio), dominant_cycle

    def _kalman_filter_price(self, closes: np.ndarray, process_noise: float = 1e-3, measurement_noise: float = 1e-1) -> tuple[np.ndarray, float]:
        """Implementasi Kalman Filter 1D sederhana secara manual."""
        n = len(closes)
        xhat = np.zeros(n)      # A posteriori estimate
        P = np.zeros(n)         # A posteriori error estimate
        xhatminus = np.zeros(n) # A priori estimate
        Pminus = np.zeros(n)    # A priori error estimate
        K = np.zeros(n)         # Gain

        # Intial guesses
        xhat[0] = closes[0]
        P[0] = 1.0

        for k in range(1, n):
            # Time update
            xhatminus[k] = xhat[k-1]
            Pminus[k] = P[k-1] + process_noise

            # Measurement update
            K[k] = Pminus[k] / (Pminus[k] + measurement_noise)
            xhat[k] = xhatminus[k] + K[k] * (closes[k] - xhatminus[k])
            P[k] = (1 - K[k]) * Pminus[k]
            
        velocity = xhat[-1] - xhat[-2]
        return xhat, float(velocity)

    def _gbm_price_distribution(self, last_price: float, closes: np.ndarray, n_steps: int = 10, n_simulations: int = 1000) -> tuple[float, float, float]:
        returns = np.diff(closes) / closes[:-1]
        mu = np.mean(returns)
        sigma = np.std(returns)
        
        simulated_paths = np.zeros((n_simulations, n_steps))
        simulated_paths[:, 0] = last_price
        
        for t in range(1, n_steps):
            z = np.random.standard_normal(n_simulations)
            simulated_paths[:, t] = simulated_paths[:, t-1] * np.exp((mu - 0.5 * sigma**2) + sigma * z)
            
        final_prices = simulated_paths[:, -1]
        return float(np.percentile(final_prices, 5)), float(np.percentile(final_prices, 50)), float(np.percentile(final_prices, 95))

    def _volatility_regime(self, highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, lookback: int = 100) -> str:
        if len(closes) < lookback: return "NORMAL"
        
        tr = np.maximum(highs[1:] - lows[1:], 
                        np.maximum(abs(highs[1:] - closes[:-1]), abs(lows[1:] - closes[:-1])))
        
        current_atr = np.mean(tr[-14:])
        historical_atr = np.mean(tr[-lookback:])
        ratio = current_atr / (historical_atr + 1e-9)
        
        if ratio > 2.0: return "CRISIS"
        if ratio > 1.2: return "HIGH"
        if ratio < 0.5: return "COMPRESSION"
        return "NORMAL"

    def _detect_false_breakout(self, o: float, h: float, l: float, c: float, atr: float) -> str:
        body = abs(c - o)
        upper_wick = h - max(o, c)
        lower_wick = min(o, c) - l
        
        # Toleransi minimal volatilitas (jangan detect false break di candle doji mati)
        if (h - l) < (atr * 0.5):
            return "NEUTRAL"
            
        if upper_wick > (1.5 * body) and upper_wick > lower_wick:
            return "FALSE_UP" # Fake pump, rejection di atas
        if lower_wick > (1.5 * body) and lower_wick > upper_wick:
            return "FALSE_DOWN" # Fake dump, bear trap
            
        return "CONFIRMED"

if __name__ == "__main__":
    # Unit Test Sederhana
    logging.basicConfig(level=logging.DEBUG)
    agent = PhysicistAgent()
    dummy_data = pd.DataFrame({
        'open': np.random.randn(200).cumsum() + 100,
        'high': np.random.randn(200).cumsum() + 102,
        'low': np.random.randn(200).cumsum() + 98,
        'close': np.random.randn(200).cumsum() + 100
    })
    
    result = asyncio.run(agent.analyze(dummy_data))
    print("\n[TEST RESULT] Physics Signal:", result)