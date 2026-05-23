import logging
from dataclasses import dataclass
from typing import Dict, Any, List, Tuple

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class AgentVote:
    agent_name: str
    direction: str
    conviction: float

@dataclass(frozen=True, slots=True)
class ConsensusResult:
    final_action: str
    confidence: float
    buy_count: int
    sell_count: int
    veto_triggered: bool
    veto_reason: str

class ConsensusEngine:
    # Bobot ditambahkan untuk agen liquidator sebagai persiapan Sesi 3
    WEIGHTS = {
        "mathematician": 0.30,
        "physicist": 0.25,
        "cryptographer": 0.20,
        "linguist": 0.15,
        "liquidation": 0.10
    }

    def __init__(self, min_confidence: float = 0.52, min_agree: int = 2):
        self.min_confidence = min_confidence
        self.min_agree = min_agree

    def evaluate(self, votes: List[AgentVote], signals: Dict[str, Any]) -> ConsensusResult:
        # 1. Eksekusi VETO rules yang ketat
        is_veto, reason = self._check_veto(signals)
        if is_veto:
            logger.warning(f"[ConsensusEngine] VETO Triggered: {reason}")
            return ConsensusResult("WAIT", 0.0, 0, 0, True, reason)

        buy_count = sum(1 for v in votes if v.direction == "BUY")
        sell_count = sum(1 for v in votes if v.direction == "SELL")
        
        total_score = 0.0
        total_weight = 0.0

        # 2. Kalkulasi bobot base
        for vote in votes:
            weight = self.WEIGHTS.get(vote.agent_name, 0.0)
            if vote.direction == "BUY":
                total_score += vote.conviction * weight
            elif vote.direction == "SELL":
                total_score -= vote.conviction * weight
            total_weight += weight

        if total_weight > 0:
            total_score /= total_weight

        # 3. Peningkatan #1: GBM Physicist Confidence Adjustment
        physics = signals.get("physicist")
        if physics and hasattr(physics, "gbm_upside_bias"):
            if physics.gbm_upside_bias > 0.6 and total_score > 0:
                # Distribusi condong ke atas -> boost BUY confidence
                total_score *= (1.0 + (physics.gbm_upside_bias - 0.5) * 0.2)
            elif physics.gbm_upside_bias < 0.4 and total_score < 0:
                # Distribusi condong ke bawah -> boost SELL confidence
                total_score *= (1.0 + (0.5 - physics.gbm_upside_bias) * 0.2)

        final_action = "WAIT"
        final_confidence = abs(total_score)

        # 4. Validasi final dengan min_agree threshold
        if final_confidence >= self.min_confidence:
            if total_score > 0 and buy_count >= self.min_agree:
                final_action = "BUY"
            elif total_score < 0 and sell_count >= self.min_agree:
                final_action = "SELL"

        logger.info(f"[ConsensusEngine] Action: {final_action} | Confidence: {final_confidence:.3f} | Buy: {buy_count} | Sell: {sell_count}")

        return ConsensusResult(
            final_action=final_action,
            confidence=final_confidence,
            buy_count=buy_count,
            sell_count=sell_count,
            veto_triggered=False,
            veto_reason=""
        )

    def _check_veto(self, signals: Dict[str, Any]) -> Tuple[bool, str]:
        """Validasi kondisi ekstrem yang memaksa bot untuk WAIT."""
        math_sig = signals.get("mathematician")
        if math_sig:
            if getattr(math_sig, "noise_ratio", 0.0) > 0.65:
                return True, "Market noise ratio melebihi batas aman"
            if getattr(math_sig, "anomaly_detected", False):
                return True, "Anomali matematis terdeteksi"

        phys_sig = signals.get("physicist")
        if phys_sig and getattr(phys_sig, "volatility_crisis", False):
            return True, "Krisis volatilitas ekstrem"

        return False, ""