import logging
from typing import Dict, Any
from analytical_engine.consensus import ConsensusEngine, AgentVote, ConsensusResult
from analytical_engine.models import Action, AnalysisSignal
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

class ExecutorAgent:
    def __init__(self, execution_client, consensus_engine: ConsensusEngine, symbol: str, leverage: int = 10):
        self.executor = execution_client
        self.consensus = consensus_engine
        self.symbol = symbol
        self.leverage = leverage

    async def execute_consensus(self, signals: Dict[str, Any], current_price: float) -> dict:
        logger.info("[ExecutorAgent] Menghitung konsensus final di harga %.2f...", current_price)
        
        votes = self._extract_votes(signals)
        consensus_result = self.consensus.vote(votes, signals)
        
        if consensus_result.final_action == "WAIT":
            # --- LOGGING DIKEMBALIKAN ---
            logger.info("[ExecutorAgent] Eksekusi di-skip. Konsensus bot menahan posisi (HOLD).")
            return {"status": "skipped", "action": "WAIT", "reason": consensus_result.reasoning}

        logger.warning("[ExecutorAgent] SIGNAL %s TRIGGERED! Mempersiapkan eksekusi...", consensus_result.final_action)

        atr = self._extract_atr(signals, current_price)
        tp_distance = atr * 2.0
        sl_distance = atr * 1.0

        if consensus_result.final_action == "BUY":
            tp_price = current_price + tp_distance
            sl_price = current_price - sl_distance
        else:
            tp_price = current_price - tp_distance
            sl_price = current_price + sl_distance

        trade_signal = AnalysisSignal(
            symbol=self.symbol,
            action=Action(consensus_result.final_action),
            entry=current_price,
            take_profit=tp_price,
            stop_loss=sl_price,
            risk_reward=2.0,
            confidence=consensus_result.confidence,
            whale_bias="NEUTRAL",
            rationale=consensus_result.reasoning,
            timestamp=datetime.now(timezone.utc),
        )
        
        try:
            # Karena MockClient.execute_signal tidak async di versi lama, kita await jika perlu. 
            order_result = await self.executor.execute_signal(trade_signal)
            logger.info("[ExecutorAgent] Order %s berhasil diregistrasi!", consensus_result.final_action)
            return {"status": "executed", "action": consensus_result.final_action, "order": order_result}
        except Exception as e:
            logger.error("[ExecutorAgent] Gagal mengeksekusi order: %s", e)
            return {"status": "failed", "error": str(e)}

    def _extract_atr(self, signals: Dict[str, Any], fallback_price: float) -> float:
        if "mathematician" in signals and hasattr(signals["mathematician"], "atr"):
            return float(signals["mathematician"].atr)
        return fallback_price * 0.015

    def _extract_votes(self, signals: Dict[str, Any]) -> list[AgentVote]:
        votes = []
        if "mathematician" in signals:
            math = signals["mathematician"]
            if math.probability_up > 0.6:
                votes.append(AgentVote("mathematician", "BUY", math.confidence))
            elif math.probability_down > 0.6:
                votes.append(AgentVote("mathematician", "SELL", math.confidence))
            else:
                votes.append(AgentVote("mathematician", "WAIT", 1.0 - math.confidence))

        if "physicist" in signals:
            physics = signals["physicist"]
            if physics.trend_direction == "UP" and physics.kalman_velocity > 0:
                votes.append(AgentVote("physicist", "BUY", physics.trend_strength))
            elif physics.trend_direction == "DOWN" and physics.kalman_velocity < 0:
                votes.append(AgentVote("physicist", "SELL", physics.trend_strength))
            else:
                votes.append(AgentVote("physicist", "WAIT", 0.5))

        return votes