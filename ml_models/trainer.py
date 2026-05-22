"""
[trainer.py]
=============
Skrip offline untuk melatih model Machine Learning lokal (Random Forest).
Menarik data historis, ekstraksi fitur, dan menyimpan model ke disk.

Eksekusi: python -m ml_models.trainer
"""

import logging
import joblib
import pandas as pd
import numpy as np
from pathlib import Path
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report
from ml_models.feature_engineer import encode_candle_sequence

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def generate_labels(df: pd.DataFrame, forward_candles: int = 3, threshold: float = 0.002) -> pd.DataFrame:
    """
    Labeling: 
    1 = UP (naik lebih dari threshold)
    -1 = DOWN (turun lebih dari threshold)
    0 = SIDEWAYS
    """
    df['future_return'] = df['close'].shift(-forward_candles) / df['close'] - 1.0
    
    conditions = [
        (df['future_return'] > threshold),
        (df['future_return'] < -threshold)
    ]
    choices = [1, -1]
    df['target'] = np.select(conditions, choices, default=0)
    return df.dropna()

def train_model(csv_path: str = None, model_path: str = "ml_models/pattern_model.joblib"):
    """Pipeline training utama."""
    logger.info("Memulai proses training ML lokal...")
    
    # 1. Load atau Generate Dummy Data (Ganti dengan fetcher lu nanti)
    if csv_path and Path(csv_path).exists():
        df = pd.read_csv(csv_path)
    else:
        logger.warning("CSV historis tidak ditemukan. Men-generate data sintesis untuk testing pipeline.")
        np.random.seed(42)
        size = 5000
        df = pd.DataFrame({
            'open': np.random.randn(size).cumsum() + 100,
            'high': np.random.randn(size).cumsum() + 102,
            'low': np.random.randn(size).cumsum() + 98,
            'close': np.random.randn(size).cumsum() + 100,
            'volume': np.random.randint(100, 10000, size)
        })

    # 2. Ekstraksi Fitur
    df_features = encode_candle_sequence(df)
    df_labeled = generate_labels(df_features)
    
    # Fitur yang dipakai oleh model
    features = [
        'body_ratio', 'upper_wick_ratio', 'lower_wick_ratio', 'vol_ratio',
        'is_bullish_engulfing', 'is_bearish_engulfing', 'is_doji'
    ]
    
    X = df_labeled[features]
    y = df_labeled['target']
    
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, shuffle=False)
    
    # 3. Training
    logger.info("Training Random Forest Classifier (n_estimators=100)...")
    clf = RandomForestClassifier(n_estimators=100, max_depth=5, random_state=42, class_weight="balanced")
    clf.fit(X_train, y_train)
    
    # 4. Evaluasi
    y_pred = clf.predict(X_test)
    logger.info("\n" + classification_report(y_test, y_pred))
    
    # 5. Simpan Model
    Path("ml_models").mkdir(exist_ok=True)
    joblib.dump(clf, model_path)
    logger.info("Model berhasil disimpan di: %s", model_path)

if __name__ == "__main__":
    train_model()