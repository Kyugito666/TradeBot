"""
[agent_cryptographer.py]
=============
Agen yang membaca "bahasa" candlestick dan order flow menggunakan
model Machine Learning lokal (Random Forest/XGBoost) tanpa AI API eksternal.

Agent: Cryptographer
Role: Pattern Recognition & Machine Learning
Dependencies: joblib, pandas, sklearn
"""

import logging
import asyncio
import joblib
import pandas as pd
from pathlib import Path
from dataclasses import dataclass
from typing import Optional, Any

from ml_models.feature_engineer import (
    encode_candle_sequence, calculate_volume_profile, 
    estimate_order_flow, detect_whale_footprint
)

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class CryptoSignal:
    pattern_detected: str
    ml_prob_up: float
    ml_prob_down: float
    ml_confidence: float
    volume_profile_poc: float
    order_flow_delta: float
    whale_score: float
    whale_direction: str
    reasoning: str

class CryptographerAgent:
    def __init__(self, model_path: str = "ml_models/pattern_model.joblib"):
        self.model_path = model_path
        self.model = self._load_model()
        
    def _load_model(self) -> Optional[Any]:
        if Path(self.model_path).exists():
            try:
                return joblib.load(self.model_path)
            except Exception as e:
                logger.error("[Cryptographer] Gagal meload model ML: %s", e)
        else:
            logger.warning("[Cryptographer] Model ML tidak ditemukan di %s. Menggunakan rule-based fallback.", self.model_path)
        return None

    # PERBAIKAN: Menghapus math_signal yang tidak dibutuhkan
    async def analyze(self, candles: pd.DataFrame) -> CryptoSignal:
        """Eksekusi non-blocking untuk prediksi ML."""
        return await asyncio.to_thread(self._run_analysis_sync, candles)

    # PERBAIKAN: Menghapus math_signal yang tidak dibutuhkan
    def _run_analysis_sync(self, df: pd.DataFrame) -> CryptoSignal:
        try:
            if df.empty or len(df) < 50:
                raise ValueError("Data candle tidak cukup untuk Cryptographer.")

            # 1. Ekstrak Fitur Dasar
            poc = calculate_volume_profile(df)
            cvd = estimate_order_flow(df)
            whale_score, whale_dir = detect_whale_footprint(df)
            
            # 2. Persiapan Data ML
            df_features = encode_candle_sequence(df)
            latest_features = df_features.iloc[-1]
            
            # Identifikasi pola teks untuk reasoning
            pattern_name = "None"
            if latest_features['is_bullish_engulfing'] == 1: pattern_name = "Bullish Engulfing"
            elif latest_features['is_bearish_engulfing'] == 1: pattern_name = "Bearish Engulfing"
            elif latest_features['is_doji'] == 1: pattern_name = "Doji"

            # 3. Prediksi ML
            prob_up = 0.0
            prob_down = 0.0
            confidence = 0.0
            
            if self.model is not None:
                features_list = [
                    'body_ratio', 'upper_wick_ratio', 'lower_wick_ratio', 'vol_ratio',
                    'is_bullish_engulfing', 'is_bearish_engulfing', 'is_doji'
                ]
                X_pred = pd.DataFrame([latest_features[features_list].values], columns=features_list)
                
                probs = self.model.predict_proba(X_pred)[0]
                classes = self.model.classes_
                
                prob_dict = dict(zip(classes, probs))
                prob_up = prob_dict.get(1, 0.0)
                prob_down = prob_dict.get(-1, 0.0)
                
                sorted_probs = sorted(probs, reverse=True)
                confidence = sorted_probs[0] - sorted_probs[1] if len(sorted_probs) > 1 else sorted_probs[0]
            else:
                if pattern_name == "Bullish Engulfing" and cvd > 0:
                    prob_up, confidence = 0.6, 0.4
                elif pattern_name == "Bearish Engulfing" and cvd < 0:
                    prob_down, confidence = 0.6, 0.4

            reasoning = (
                f"Pattern: {pattern_name}. ML P(Up): {prob_up:.2%}, P(Down): {prob_down:.2%}. "
                f"CVD: {cvd:.2f}. Whale: {whale_dir} ({whale_score:.2f}). POC: {poc:.2f}."
            )
            
            logger.info("[Cryptographer] Analisis selesai | pattern=%s P(up)=%.2f confidence=%.2f", pattern_name, prob_up, confidence)

            return CryptoSignal(
                pattern_detected=pattern_name,
                ml_prob_up=round(float(prob_up), 4),
                ml_prob_down=round(float(prob_down), 4),
                ml_confidence=round(float(confidence), 4),
                volume_profile_poc=round(float(poc), 4),
                order_flow_delta=round(float(cvd), 4),
                whale_score=whale_score,
                whale_direction=whale_dir,
                reasoning=reasoning
            )

        except Exception as e:
            logger.exception("[Cryptographer] Kalkulasi gagal: %s", e)
            return CryptoSignal("Error", 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, "NEUTRAL", "Cryptographer error.")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    agent = CryptographerAgent()
    dummy_data = pd.DataFrame({
        'open': [100]*200, 'high': [102]*200, 'low': [98]*200, 'close': [100]*200, 'volume': [1000]*200
    })
    res = asyncio.run(agent.analyze(dummy_data))
    print(res)