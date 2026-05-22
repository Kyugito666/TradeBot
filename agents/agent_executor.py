"""
[agent_executor.py]
=============
Agen orkestrator yang mengumpulkan semua data analisis, memicu ConsensusEngine,
menjalankan manajemen risiko (DrawdownGuard, PositionSizer), dan mengeksekusi order.

Agent: Executor / Data Engineer
Role: Pipeline Orchestration & Exchange Execution
Dependencies: evaluators, risk_engine, execution_engine
"""

import logging
from typing import Dict, Any

from analytical_engine.evaluator import ConsensusEngine, AgentVote, ConsensusResult
from execution_engine.executor import TradeExecutor
# TODO: Import DrawdownGuard dan position_sizer di Fase 4

logger = logging.getLogger(__name__)

class ExecutorAgent:
    def __init__(self, execution_client: TradeExecutor, consensus_engine: ConsensusEngine, symbol: str, leverage: int = 10):
        self.executor = execution_client
        self.consensus = consensus_engine
        self.symbol = symbol
        self.leverage = leverage

    async def execute_consensus(self, signals: Dict[str, Any]) -> dict:
        """
        Menerima dictionary berisi hasil sinyal dari semua agent.
        Format signals: {"mathematician": MathSignal, "physicist": PhysicsSignal, ...}
        """
        logger.info("[ExecutorAgent] Menyiapkan rapat konsensus untuk %s...", self.symbol)

        # 1. Parsing Sinyal menjadi Vote
        votes = self._extract_votes(signals)
        
        # 2. Hitung Konsensus
        consensus_result = self.consensus.vote(votes, signals)
        
        # 3. Logika Eksekusi
        if consensus_result.final_action == "WAIT":
            logger.info("[ExecutorAgent] Konsensus WAIT. Menunggu siklus berikutnya. Alasan: %s", consensus_result.reasoning)
            return {"status": "skipped", "action": "WAIT", "reason": consensus_result.reasoning}

        logger.warning("[ExecutorAgent] SIGNAL %s TRIGGERED! Confidence: %.2f", 
                       consensus_result.final_action, consensus_result.confidence)

        # 4. TODO: Validasi Risk Management (Drawdown Guard & Position Sizing) di Fase 4
        # Misalnya: 
        # is_safe, reason = self.drawdown_guard.is_trading_allowed()
        # if not is_safe: return {"status": "blocked", "reason": reason}
        
        risk_pct = 0.01 # Hardcode sementara 1% risk
        
        try:
            # 5. Tembak Order ke Exchange
            # (Asumsi lu punya fungsi create_order di execution_engine/executor.py)
            order_result = await self.executor.create_order(
                symbol=self.symbol,
                side=consensus_result.final_action,
                order_type="MARKET",
                leverage=self.leverage,
                # size=calculated_size, -> akan diganti setelah position_sizer kelar
            )
            
            logger.info("[ExecutorAgent] Order %s berhasil tereksekusi! Result: %s", consensus_result.final_action, order_result)
            return {"status": "executed", "action": consensus_result.final_action, "order": order_result}
            
        except Exception as e:
            logger.error("[ExecutorAgent] Gagal mengeksekusi order: %s", e)
            return {"status": "failed", "error": str(e)}

    def _extract_votes(self, signals: Dict[str, Any]) -> list[AgentVote]:
        """Terjemahkan sinyal dataclass spesifik ke format AgentVote standar."""
        votes = []
        
        # Parse Math Signal
        if "mathematician" in signals:
            math = signals["mathematician"]
            # Logic: P(up) vs P(down). Jika beda tipis, Wait.
            if math.probability_up > 0.6:
                votes.append(AgentVote("mathematician", "BUY", math.confidence))
            elif math.probability_down > 0.6:
                votes.append(AgentVote("mathematician", "SELL", math.confidence))
            else:
                votes.append(AgentVote("mathematician", "WAIT", 1.0 - math.confidence))

        # Parse Physics Signal
        if "physicist" in signals:
            physics = signals["physicist"]
            if physics.trend_direction == "UP" and physics.kalman_velocity > 0:
                votes.append(AgentVote("physicist", "BUY", physics.trend_strength))
            elif physics.trend_direction == "DOWN" and physics.kalman_velocity < 0:
                votes.append(AgentVote("physicist", "SELL", physics.trend_strength))
            else:
                votes.append(AgentVote("physicist", "WAIT", 0.5))

        # TODO: Parse Crypto & Linguist Signal setelah Fase 3 selesai

        return votes