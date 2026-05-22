"""
[feature_engineer.py]
=============
Modul untuk mengekstrak fitur ML dari raw OHLCV.
Mengubah pola candlestick, profil volume, dan order flow menjadi vektor numerik
yang bisa dipahami oleh model scikit-learn/xgboost.

Agent: Cryptographer (Dependency)
Role: Data Transformation & Feature Extraction
Dependencies: numpy, pandas
"""

import numpy as np
import pandas as pd
from typing import Dict, Any, Tuple

def encode_candle_sequence(df: pd.DataFrame) -> pd.DataFrame:
    """
    Ekstrak fitur dari OHLCV untuk dimasukkan ke model ML.
    
    Args:
        df: DataFrame OHLCV (open, high, low, close, volume)
        
    Returns:
        DataFrame baru dengan fitur tambahan
    """
    df = df.copy()
    
    # Range dan Body
    df['range'] = df['high'] - df['low']
    df['body'] = df['close'] - df['open']
    
    # Hindari division by zero
    safe_range = df['range'].replace(0, 1e-9)
    
    df['body_ratio'] = df['body'] / safe_range
    df['upper_wick'] = df['high'] - df[['open', 'close']].max(axis=1)
    df['lower_wick'] = df[['open', 'close']].min(axis=1) - df['low']
    df['upper_wick_ratio'] = df['upper_wick'] / safe_range
    df['lower_wick_ratio'] = df['lower_wick'] / safe_range
    
    # Volume dynamics
    df['vol_sma_20'] = df['volume'].rolling(20).mean()
    df['vol_ratio'] = df['volume'] / df['vol_sma_20'].replace(0, 1e-9)
    
    # Deteksi Pola Candlestick Sederhana (Boolean -> 0/1)
    df['is_bullish_engulfing'] = (
        (df['close'] > df['open']) & 
        (df['open'] < df['close'].shift(1)) & 
        (df['close'] > df['open'].shift(1)) & 
        (df['close'].shift(1) < df['open'].shift(1))
    ).astype(int)
    
    df['is_bearish_engulfing'] = (
        (df['close'] < df['open']) & 
        (df['open'] > df['close'].shift(1)) & 
        (df['close'] < df['open'].shift(1)) & 
        (df['close'].shift(1) > df['open'].shift(1))
    ).astype(int)
    
    df['is_doji'] = (abs(df['body']) < (df['range'] * 0.1)).astype(int)
    
    # Drop NaN akibat rolling
    return df.fillna(0)

def calculate_volume_profile(df: pd.DataFrame, bins: int = 50) -> float:
    """
    Menghitung Point of Control (POC) dari Volume Profile.
    POC = Harga di mana volume paling banyak diperdagangkan.
    """
    if df.empty:
        return 0.0
        
    hist, bin_edges = np.histogram(df['close'], bins=bins, weights=df['volume'])
    max_vol_idx = np.argmax(hist)
    poc = (bin_edges[max_vol_idx] + bin_edges[max_vol_idx + 1]) / 2.0
    return float(poc)

def estimate_order_flow(df: pd.DataFrame, window: int = 20) -> float:
    """
    Estimasi Cumulative Volume Delta (CVD) menggunakan Tick Rule proxy.
    + = Buy pressure dominan, - = Sell pressure dominan.
    """
    if len(df) < window:
        return 0.0
        
    recent = df.tail(window).copy()
    # Asumsi: close > open -> buy volume, close < open -> sell volume
    recent['delta'] = np.where(recent['close'] > recent['open'], recent['volume'], 
                      np.where(recent['close'] < recent['open'], -recent['volume'], 0))
    
    cvd = recent['delta'].sum()
    return float(cvd)

def detect_whale_footprint(df: pd.DataFrame) -> Tuple[float, str]:
    """
    Deteksi spike volume ekstrem yang mengindikasikan pergerakan institusi.
    
    Returns:
        (score 0.0 - 1.0, direction "BUY"|"SELL"|"NEUTRAL")
    """
    if len(df) < 50:
        return 0.0, "NEUTRAL"
        
    recent_vol = df['volume'].iloc[-1]
    vol_mean = df['volume'].iloc[-50:-1].mean()
    vol_std = df['volume'].iloc[-50:-1].std()
    
    if vol_std == 0:
        return 0.0, "NEUTRAL"
        
    z_score = (recent_vol - vol_mean) / vol_std
    
    if z_score > 2.5:
        score = min(z_score / 5.0, 1.0)
        body = df['close'].iloc[-1] - df['open'].iloc[-1]
        
        if body > 0:
            return round(float(score), 4), "BUY"
        elif body < 0:
            return round(float(score), 4), "SELL"
            
    return 0.0, "NEUTRAL"