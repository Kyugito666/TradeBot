"""
[position_sizer.py]
=============
Modul perhitungan ukuran posisi (position sizing) berdasarkan risiko.
Mengimplementasikan Fixed Fractional, Kelly Criterion, dan Volatility-based (ATR) sizing.

Agent: Executor (Dependency)
Role: Risk Management & Capital Allocation
Dependencies: math
"""

import logging
import math

logger = logging.getLogger(__name__)

class PositionSizer:
    @staticmethod
    def fixed_fractional_size(balance: float, risk_pct: float, entry_price: float, stop_loss_price: float) -> float:
        """
        Risk percentage konstan (misal 1% dari balance tiap trade).
        Size = (Balance * Risk_Pct) / Jarak Stop Loss
        """
        if entry_price == stop_loss_price:
            logger.warning("[PositionSizer] Entry dan Stop Loss sama. Mengembalikan size 0.")
            return 0.0
            
        risk_amount = balance * risk_pct
        stop_distance = abs(entry_price - stop_loss_price)
        
        # Berapa koin/lot yang bisa dibeli dengan batas risiko tersebut
        size_in_base_asset = risk_amount / stop_distance
        return round(size_in_base_asset, 6)

    @staticmethod
    def kelly_criterion_size(balance: float, win_rate: float, avg_win_pct: float, avg_loss_pct: float, fraction: float = 0.25) -> float:
        """
        Kelly Criterion mengoptimalkan pertumbuhan modal majemuk.
        Menggunakan Fractional Kelly (default Quarter-Kelly / 0.25) untuk meredam volatilitas drawdown.
        
        Rumus: K% = W - ((1 - W) / R)
        W = Win Rate, R = Reward/Risk Ratio
        """
        if avg_loss_pct == 0 or win_rate == 0:
            return 0.0
            
        r_ratio = avg_win_pct / abs(avg_loss_pct)
        kelly_pct = win_rate - ((1.0 - win_rate) / r_ratio)
        
        if kelly_pct <= 0:
            logger.info("[PositionSizer] Kelly negatif/nol (Edge tidak ada). Trade dibatalkan.")
            return 0.0
            
        safe_kelly_pct = kelly_pct * fraction
        # Limit maksimal risk per trade = 5% untuk safety
        actual_risk_pct = min(safe_kelly_pct, 0.05)
        
        position_value = balance * actual_risk_pct
        logger.debug("[PositionSizer] Full Kelly: %.2f%% | Applied (1/4) Kelly: %.2f%%", kelly_pct*100, actual_risk_pct*100)
        
        return position_value

    @staticmethod
    def atr_based_size(balance: float, risk_pct: float, atr: float, multiplier: float = 2.0) -> float:
        """
        Sizing dinamis berdasarkan volatilitas pasar saat ini.
        Makin volatil pasar (ATR tinggi), makin kecil size-nya.
        """
        if atr == 0: return 0.0
        
        risk_amount = balance * risk_pct
        stop_distance = atr * multiplier
        
        size = risk_amount / stop_distance
        return round(size, 6)