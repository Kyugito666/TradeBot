"""
[drawdown_guard.py]
=============
Sistem pengaman otomatis (Circuit Breaker).
Mengeblok eksekusi jika batas kerugian harian atau batas kerugian beruntun tercapai.

Agent: Core System
Role: Capital Preservation & Tilt Prevention
Dependencies: datetime
"""

import logging
from datetime import datetime, date, timedelta
from dataclasses import dataclass

logger = logging.getLogger(__name__)

@dataclass
class DrawdownState:
    current_date: date
    daily_pnl_pct: float
    consecutive_losses: int
    cooldown_until: datetime

class DrawdownGuard:
    def __init__(
        self,
        max_daily_drawdown_pct: float = 0.05,  # 5% max loss per hari
        max_consecutive_losses: int = 3,       # Max 3x loss beruntun
        cooldown_minutes: int = 60             # Istirahat 1 jam jika trigger
    ):
        self.max_dd = max_daily_drawdown_pct
        self.max_losses = max_consecutive_losses
        self.cooldown = timedelta(minutes=cooldown_minutes)
        
        self.state = DrawdownState(
            current_date=datetime.now().date(),
            daily_pnl_pct=0.0,
            consecutive_losses=0,
            cooldown_until=datetime.min
        )

    def _check_and_reset_daily(self):
        """Reset state PnL harian jika hari sudah berganti."""
        today = datetime.now().date()
        if today > self.state.current_date:
            self.state.current_date = today
            self.state.daily_pnl_pct = 0.0
            self.state.consecutive_losses = 0

    def record_trade_result(self, pnl_pct: float) -> None:
        """Dipanggil setiap kali trade ditutup/settle."""
        self._check_and_reset_daily()
        
        self.state.daily_pnl_pct += pnl_pct
        
        if pnl_pct < 0:
            self.state.consecutive_losses += 1
        else:
            self.state.consecutive_losses = 0 # Reset streak jika profit
            
        logger.info("[DrawdownGuard] PnL Tercatat: %.2f%% | Total Harian: %.2f%% | Loss Streak: %d", 
                    pnl_pct*100, self.state.daily_pnl_pct*100, self.state.consecutive_losses)

    def is_trading_allowed(self) -> tuple[bool, str]:
        """
        Evaluasi apakah sistem diizinkan mengambil posisi baru.
        Returns: (True/False, reason_string)
        """
        self._check_and_reset_daily()
        now = datetime.now()

        # 1. Cek Cooldown
        if now < self.state.cooldown_until:
            wait_time = (self.state.cooldown_until - now).total_seconds() / 60
            return False, f"COOLDOWN_ACTIVE: Menunggu {wait_time:.0f} menit lagi."

        # 2. Cek Daily Drawdown
        if self.state.daily_pnl_pct <= -self.max_dd:
            # Trigger cooldown parah sampai besok
            tomorrow = datetime.combine(self.state.current_date + timedelta(days=1), datetime.min.time())
            self.state.cooldown_until = tomorrow
            return False, f"MAX_DAILY_DRAWDOWN: Kerugian harian mencapai {-self.state.daily_pnl_pct*100:.1f}%. Bot dihentikan hari ini."

        # 3. Cek Consecutive Losses
        if self.state.consecutive_losses >= self.max_losses:
            self.state.cooldown_until = now + self.cooldown
            # Reset streak counter secara virtual agar nanti bisa lanjut setelah cooldown
            self.state.consecutive_losses = 0 
            return False, f"MAX_LOSS_STREAK: {self.max_losses} kerugian beruntun. Pendinginan {self.cooldown.total_seconds()/60:.0f} menit."

        return True, "SYSTEM_NOMINAL"