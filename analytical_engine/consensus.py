import logging
from dataclasses import dataclass
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

@dataclass
class AgentVote:
    agent_name: str
    action: str
    confidence: float

@dataclass
class ConsensusResult:
    final_action: str
    confidence: float
    vote_breakdown: dict
    reasoning: str

class ConsensusEngine:
    _WEIGHTS: dict[str, float] = {
        "mathematician": 0.30,
        "physicist": 0.30,
        "cryptographer": 0.25,
        "linguist": 0.15,
    }
    MIN_CONFIDENCE: float = 0.45

    def vote(self, votes: List[AgentVote], raw_signals: Dict[str, Any]) -> ConsensusResult:
        physics = raw_signals.get("physicist")
        if physics and getattr(physics, "is_false_breakout", False):
            reasoning = "VETO TRIGGERED: Physicist mendeteksi False Breakout (Wick penolakan ekstrem)."
            logger.warning("[ConsensusEngine] %s", reasoning)
            return ConsensusResult(
                final_action="WAIT",
                confidence=0.0,
                vote_breakdown={v.agent_name: v.action for v in votes},
                reasoning=reasoning,
            )

        score_buy = 0.0
        score_sell = 0.0
        score_wait = 0.0

        for v in votes:
            w = self._WEIGHTS.get(v.agent_name, 0.10)
            weighted = w * v.confidence
            if v.action == "BUY":
                score_buy += weighted
            elif v.action == "SELL":
                score_sell += weighted
            else:
                score_wait += weighted

        total = score_buy + score_sell + score_wait or 1.0
        norm_buy = score_buy / total
        norm_sell = score_sell / total

        if norm_buy > norm_sell and norm_buy >= self.MIN_CONFIDENCE:
            action = "BUY"
            confidence = norm_buy
        elif norm_sell > norm_buy and norm_sell >= self.MIN_CONFIDENCE:
            action = "SELL"
            confidence = norm_sell
        else:
            action = "WAIT"
            confidence = max(norm_buy, norm_sell)

        breakdown = {v.agent_name: f"{v.action}({v.confidence:.2f})" for v in votes}
        reasoning = f"BUY_score={score_buy:.3f} | SELL_score={score_sell:.3f} | WAIT_score={score_wait:.3f}"

        # --- LOGGING DIKEMBALIKAN ---
        if action == "WAIT":
            logger.info("[ConsensusEngine] Hasil: WAIT | %s", reasoning)
        else:
            logger.warning("[ConsensusEngine] 🔥 Hasil: %s (Conf: %.2f) | %s", action, confidence, reasoning)

        return ConsensusResult(
            final_action=action,
            confidence=round(confidence, 4),
            vote_breakdown=breakdown,
            reasoning=reasoning,
        )