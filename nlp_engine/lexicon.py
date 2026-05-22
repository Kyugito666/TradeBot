"""
[lexicon.py]
=============
Kamus kata finansial spesifik kripto/saham beserta bobot sentimennya.
Digunakan untuk menginjeksi vocabulary khusus ke dalam engine VADER.

Agent: Linguist (Dependency)
Role: Domain-Specific Vocabulary
Dependencies: None
"""

BULLISH_TERMS = {
    "bullish": 1.0, "pump": 0.8, "moon": 0.9, "ath": 1.0, "all-time high": 1.0,
    "rally": 0.8, "breakout": 0.7, "surge": 0.8, "soar": 0.9, "spike": 0.6,
    "accumulation": 0.9, "buy": 0.5, "long": 0.5, "profit": 0.7, "bull": 0.8,
    "uptrend": 0.8, "support": 0.5, "recovery": 0.7, "adoption": 0.6,
    "institutional": 0.7, "etf approval": 1.0, "fed pivot": 0.8,
    "naik": 0.6, "terbang": 0.9, "meledak": 0.8, "hijau": 0.5, "cuan": 0.8
}

BEARISH_TERMS = {
    "crash": -1.0, "dump": -0.9, "bear": -0.7, "bearish": -0.8, "sell": -0.5,
    "short": -0.5, "bankrupt": -1.0, "hack": -0.9, "fraud": -1.0, "scam": -1.0,
    "regulation": -0.6, "ban": -0.9, "lawsuit": -0.8, "panic": -0.9, "fear": -0.7,
    "collapse": -1.0, "liquidation": -0.7, "margin call": -0.8, "rug pull": -1.0,
    "turun": -0.6, "jeblok": -0.9, "amblas": -0.9, "hancur": -0.8, "merah": -0.5
}