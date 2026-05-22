"""
[evaluator.py]
=============
Consensus Engine untuk mengevaluasi sinyal dari semua agen.
Menghitung skor probabilitas gabungan dan menerapkan aturan VETO keras
berdasarkan parameter fisika dan statistik pasar.

Agent: N/A (Core Engine)
Role: Signal Aggregator & Veto Enforcer
Dependencies: dataclasses, typing
"""

import logging
from dataclasses import dataclass, field
from typing import Dict, Any, List, Optional

from agents.agent_mathematician import MathSignal
from agents.agent_physicist import PhysicsSignal
# TODO: Import CryptoSignal dan SentimentSignal saat Fase 3 selesai

logger = logging.getLogger(__name__)

@dataclass
class AgentVote:
    agent_name: str
    direction: str  # "BUY" | "SELL" | "WAIT"
    conviction: float  # 0.0 - 1.0

@dataclass(frozen=True, slots=True)
class ConsensusResult:
    final_action: str
    weighted_score: float
    confidence: float
    agents_agree: int
    veto_triggered: bool
    veto_reason: str
    agent_breakdown: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    reasoning: str = ""

class ConsensusEngine:
    """
    Menggabungkan output 5 agent menjadi satu keputusan final.
    """
    # Bobot total = 1.0 (100%)
    WEIGHTS = {
        "mathematician": 0.30,
        "physicist": 0.25,
        "cryptographer": 0.25,
        "linguist": 0.10,
        "liquidation": 0.10,
    }

    def __init__(self, min_confidence: float = 0.55, min_agree: int = 3):
        self.min_confidence = min_confidence
        self.min_agree = min_agree

    def vote(self, votes: List[AgentVote], signals: Dict[str, Any]) -> ConsensusResult:
        """
        Kalkulasi hasil voting akhir.
        `signals` berisi raw dataclass dari masing-masing agent untuk cek VETO.
        """
        # 1. Cek Veto Rules terlebih dahulu
        veto_active, veto_reason = self._apply_veto_rules(signals)
        
        breakdown = {}
        total_score = 0.0
        buy_count = 0
        sell_count = 0

        # 2. Tabulasi Vote
        for v in votes:
            if v.agent_name not in self.WEIGHTS:
                continue
                
            weight = self.WEIGHTS[v.agent_name]
            breakdown[v.agent_name] = {"vote": v.direction, "conviction": v.conviction}

            if v.direction == "BUY":
                total_score += (v.conviction * weight)
                buy_count += 1
            elif v.direction == "SELL":
                total_score -= (v.conviction * weight)
                sell_count += 1

        # 3. Analisis Hasil Konsensus
        final_action = "WAIT"
        confidence = abs(total_score)
        agents_agree = max(buy_count, sell_count)
        reasoning = ""

        if veto_active:
            final_action = "WAIT"
            reasoning = f"VETO TRIGGERED: {veto_reason}"
        else:
            if total_score > 0 and buy_count >= self.min_agree and confidence >= self.min_confidence:
                final_action = "BUY"
                reasoning = f"Bulls win with {buy_count} votes. Confidence: {confidence:.2f}"
            elif total_score < 0 and sell_count >= self.min_agree and confidence >= self.min_confidence:
                final_action = "SELL"
                reasoning = f"Bears win with {sell_count} votes. Confidence: {confidence:.2f}"
            else:
                reasoning = (f"No clear consensus. Agree: {agents_agree}/{len(votes)}, "
                             f"Confidence: {confidence:.2f} (Min: {self.min_confidence})")

        logger.info("[ConsensusEngine] Action: %s | Score: %.2f | Veto: %s", final_action, total_score, veto_active)

        return ConsensusResult(
            final_action=final_action,
            weighted_score=round(total_score, 4),
            confidence=round(confidence, 4),
            agents_agree=agents_agree,
            veto_triggered=veto_active,
            veto_reason=veto_reason,
            agent_breakdown=breakdown,
            reasoning=reasoning
        )

    def _apply_veto_rules(self, signals: Dict[str, Any]) -> tuple[bool, str]:
        """
        Mengevaluasi sinyal mentah untuk mencegah entry di kondisi pasar berbahaya.
        Returns: (is_vetoed, reason)
        """
        physics: Optional[PhysicsSignal] = signals.get("physicist")
        math_sig: Optional[MathSignal] = signals.get("mathematician")

        if physics:
            if physics.is_false_breakout:
                return True, "Physicist mendeteksi False Breakout (Wick panjang)."
            if physics.noise_ratio > 0.7:
                return True, f"Pasar terlalu noisy (Noise Ratio: {physics.noise_ratio:.2f} > 0.70)."
            if physics.volatility_regime == "CRISIS":
                return True, "Volatilitas level CRISIS (Risiko slippage fatal)."

        if math_sig:
            if math_sig.regime == "UNKNOWN" or (math_sig.anomaly_score > 0.95 and physics and physics.volatility_regime != "COMPRESSION"):
                return True, "Anomali matematis ekstrem tanpa kompresi volatilitas."

        return False, ""