import logging
import pandas as pd
import numpy as np
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class MathSignal:
    prob_up: float
    prob_down: float
    noise_ratio: float
    anomaly_detected: bool

class MathematicianAgent:
    def __init__(self, period: int = 14):
        self.period = period

    async def analyze(self, df: pd.DataFrame) -> MathSignal:
        """Menjalankan analisis stochastics dan Bayesian inference pada harga."""
        if df.empty or len(df) < self.period * 2:
            return MathSignal(0.5, 0.5, 0.0, False)

        closes = df['close'].values
        highs = df['high'].values
        lows = df['low'].values

        # 1. Kalkulasi Indikator Dasar
        rsi_val = self._calculate_rsi(closes)
        z_score = self._calculate_zscore(closes)
        noise_ratio = self._calculate_noise(highs, lows, closes)
        anomaly = z_score > 4.0 or z_score < -4.0

        # 2. Inisialisasi Probabilitas (Prior)
        prob_up = 0.5
        
        # 3. Bayesian Chain Update (Sequential, non-replacement)
        # Evidence 1: RSI (Momentum)
        if rsi_val < 30:
            # Oversold -> Likelihood UP naik
            prob_up = self._bayesian_update(prob_up, likelihood_up=0.72, likelihood_down=0.28)
        elif rsi_val > 70:
            # Overbought -> Likelihood DOWN naik (UP turun)
            prob_up = self._bayesian_update(prob_up, likelihood_up=0.28, likelihood_down=0.72)

        # Evidence 2: Z-Score (Mean Reversion)
        if z_score < -2.0:
            # Jauh di bawah mean -> Harga cenderung kembali naik
            prob_up = self._bayesian_update(prob_up, likelihood_up=0.65, likelihood_down=0.35)
        elif z_score > 2.0:
            # Jauh di atas mean -> Harga cenderung kembali turun
            prob_up = self._bayesian_update(prob_up, likelihood_up=0.35, likelihood_down=0.65)

        # 4. Finalisasi Probabilitas (Posterior)
        prob_down = 1.0 - prob_up

        return MathSignal(
            prob_up=float(prob_up),
            prob_down=float(prob_down),
            noise_ratio=float(noise_ratio),
            anomaly_detected=anomaly
        )

    def _bayesian_update(self, prior_up: float, likelihood_up: float, likelihood_down: float) -> float:
        """
        Kalkulasi posterior probability murni menggunakan Teorema Bayes.
        P(Up | Evidence) = (P(Evidence | Up) * P(Up)) / P(Evidence)
        """
        prior_down = 1.0 - prior_up
        
        # Denominator (Marginal likelihood dari bukti)
        evidence_prob = (likelihood_up * prior_up) + (likelihood_down * prior_down)
        
        if evidence_prob == 0:
            return prior_up
            
        posterior_up = (likelihood_up * prior_up) / evidence_prob
        return posterior_up

    def _calculate_rsi(self, closes: np.ndarray) -> float:
        deltas = np.diff(closes)
        seed = deltas[:self.period]
        up = seed[seed >= 0].sum() / self.period
        down = -seed[seed < 0].sum() / self.period
        
        if down == 0:
            return 100.0
            
        rs = up / down
        rsi = 100.0 - (100.0 / (1.0 + rs))
        
        for i in range(self.period, len(closes) - 1):
            delta = deltas[i]
            if delta > 0:
                upval = delta
                downval = 0.0
            else:
                upval = 0.0
                downval = -delta
                
            up = (up * (self.period - 1) + upval) / self.period
            down = (down * (self.period - 1) + downval) / self.period
            
            if down > 0:
                rs = up / down
                rsi = 100.0 - (100.0 / (1.0 + rs))
            else:
                rsi = 100.0
                
        return float(rsi)

    def _calculate_zscore(self, closes: np.ndarray) -> float:
        window = closes[-self.period:]
        mean = np.mean(window)
        std = np.std(window)
        if std == 0:
            return 0.0
        return float((closes[-1] - mean) / std)
        
    def _calculate_noise(self, highs: np.ndarray, lows: np.ndarray, closes: np.ndarray) -> float:
        """Kalkulasi rasio noise berdasarkan perbandingan sumbu/shadow candle terhadap body."""
        body = np.abs(closes[-1] - closes[-2])
        total_range = highs[-1] - lows[-1]
        
        if total_range == 0:
            return 0.0
            
        shadows = total_range - body
        return float(shadows / total_range)