import asyncio
import logging
from typing import Dict, Any, List

# Perbaikan Import: Selalu rujuk ke engine konsensus versi canggih
from analytical_engine.evaluator import AgentVote

logger = logging.getLogger(__name__)

class AgentExecutor:
    def __init__(self, agents: Dict[str, Any]):
        """
        Orkestrator untuk mengeksekusi multiple agent dan memanen sinyal mereka.
        agents: Dict berisi instansiasi masing-masing agent.
        """
        self.agents = agents

    async def gather_signals(self, df: Any, current_price: float, symbol: str, **kwargs) -> Dict[str, Any]:
        """
        Menjalankan semua agen secara asinkron/konkuren untuk meminimalkan latensi.
        """
        tasks = {}
        
        if "mathematician" in self.agents:
            tasks["mathematician"] = asyncio.create_task(self.agents["mathematician"].analyze(df))
            
        if "physicist" in self.agents:
            tasks["physicist"] = asyncio.create_task(self.agents["physicist"].analyze(df, current_price))
            
        if "cryptographer" in self.agents:
            tasks["cryptographer"] = asyncio.create_task(self.agents["cryptographer"].analyze(df))
            
        if "linguist" in self.agents:
            tasks["linguist"] = asyncio.create_task(self.agents["linguist"].analyze(symbol))
            
        if "liquidator" in self.agents:
            oi = kwargs.get("oi", 0.0)
            lsr = kwargs.get("lsr", 1.0)
            tasks["liquidator"] = asyncio.create_task(self.agents["liquidator"].analyze(df, oi, lsr, symbol))

        signals = {}
        for agent_name, task in tasks.items():
            try:
                result = await task
                if result:
                    signals[agent_name] = result
            except Exception as e:
                logger.error(f"[AgentExecutor] Agen '{agent_name}' gagal: {e}")
                
        return signals

    def extract_votes(self, signals: Dict[str, Any]) -> List[AgentVote]:
        return self._extract_votes(signals)

    def _extract_votes(self, signals: Dict[str, Any]) -> List[AgentVote]:
        """
        Mengubah sinyal mentah menjadi bentuk AgentVote terstandarisasi.
        """
        votes = []
        
        # 1. Mathematician
        if "mathematician" in signals:
            math = signals["mathematician"]
            prob_up = getattr(math, "prob_up", 0.5)
            prob_down = getattr(math, "prob_down", 0.5)
            
            if prob_up > 0.6:
                votes.append(AgentVote(agent_name="mathematician", direction="BUY", conviction=prob_up))
            elif prob_down > 0.6:
                votes.append(AgentVote(agent_name="mathematician", direction="SELL", conviction=prob_down))
            else:
                votes.append(AgentVote(agent_name="mathematician", direction="WAIT", conviction=0.5))

        # 2. Physicist
        if "physicist" in signals:
            phys = signals["physicist"]
            direction = getattr(phys, "direction", "WAIT")
            conviction = getattr(phys, "confidence", 0.5)
            
            if direction in ("BUY", "SELL"):
                votes.append(AgentVote(agent_name="physicist", direction=direction, conviction=conviction))
            else:
                votes.append(AgentVote(agent_name="physicist", direction="WAIT", conviction=0.5))

        # 3. Cryptographer (BUG #2 FIXED)
        if "cryptographer" in signals:
            crypto = signals["cryptographer"]
            ml_up = getattr(crypto, "ml_prob_up", 0.0)
            ml_down = getattr(crypto, "ml_prob_down", 0.0)
            ml_conf = getattr(crypto, "ml_confidence", 0.0)
            
            if ml_up > 0.55 and ml_conf > 0.3:
                votes.append(AgentVote(agent_name="cryptographer", direction="BUY", conviction=ml_conf))
            elif ml_down > 0.55 and ml_conf > 0.3:
                votes.append(AgentVote(agent_name="cryptographer", direction="SELL", conviction=ml_conf))
            else:
                votes.append(AgentVote(agent_name="cryptographer", direction="WAIT", conviction=0.5))

        # 4. Linguist (BUG #2 FIXED)
        if "linguist" in signals:
            nlp = signals["linguist"]
            sentiment = getattr(nlp, "sentiment_label", "NEUTRAL")
            news_count = getattr(nlp, "news_count", 0)
            confidence = getattr(nlp, "confidence", 0.0)
            
            if sentiment in ("BULLISH", "VERY_BULLISH") and news_count >= 3:
                votes.append(AgentVote(agent_name="linguist", direction="BUY", conviction=confidence))
            elif sentiment in ("BEARISH", "VERY_BEARISH") and news_count >= 3:
                votes.append(AgentVote(agent_name="linguist", direction="SELL", conviction=confidence))
            else:
                votes.append(AgentVote(agent_name="linguist", direction="WAIT", conviction=confidence * 0.5))
                
        # 5. Liquidator (ENHANCEMENT #3 PREP)
        if "liquidator" in signals:
            liq = signals["liquidator"]
            direction = getattr(liq, "direction", "NEUTRAL")
            confidence = getattr(liq, "confidence", 0.0)
            
            if direction in ("BUY", "SELL"):
                votes.append(AgentVote(agent_name="liquidator", direction=direction, conviction=confidence))
            else:
                votes.append(AgentVote(agent_name="liquidator", direction="WAIT", conviction=0.0))

        return votes