import asyncio
import logging
import os
import json
from datetime import datetime, timezone
from dotenv import load_dotenv

# --- Imports ---
from analytical_engine.evaluator import ConsensusEngine
from agents.agent_mathematician import MathematicianAgent
from agents.agent_physicist import PhysicistAgent
from agents.agent_cryptographer import CryptographerAgent
from agents.agent_linguist import LinguistAgent
from agents.agent_executor import ExecutorAgent
from risk_engine.drawdown_guard import DrawdownGuard

# --- Setup Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("QuantBotMain")

# --- Utils ---
def write_insight(status: str, detail: dict):
    """Atomic write ke bot_system.json"""
    try:
        temp_file = "bot_system.json.tmp"
        payload = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "status": status,
            "data": detail
        }
        with open(temp_file, "w") as f:
            json.dump(payload, f, indent=4)
        os.replace(temp_file, "bot_system.json")
    except Exception as e:
        logger.error("Gagal menulis system insight: %s", e)

# --- Main Flow ---
async def main():
    logger.info("=== INITIALIZING QUANT BOT ===")
    load_dotenv()
    
    symbol = os.getenv("SYMBOL", "BTCUSDT")
    trading_style = os.getenv("TRADING_STYLE", "daytrade")
    enable_sentiment = int(os.getenv("ENABLE_SENTIMENT", 1))
    
    # ── Dinamisasi Interval Berdasarkan Style ──
    if trading_style == "scalping":
        loop_interval = 30     # Sangat agresif, evaluasi tiap 30 detik
    elif trading_style == "sniper":
        loop_interval = 300    # Sangat sabar, evaluasi tiap 5 menit
    else:
        loop_interval = 120    # Default Daytrade, 2 menit
    
    # Mock Class untuk Testing/Dry Run
    class MockClient:
        async def create_order(self, **kwargs): return {"id": "mock_order", "status": "filled"}
    class MockFetcher:
        async def fetch(self): 
            import pandas as pd, numpy as np
            return pd.DataFrame({
                'open': np.random.randn(200).cumsum() + 100,
                'high': np.random.randn(200).cumsum() + 102,
                'low': np.random.randn(200).cumsum() + 98,
                'close': np.random.randn(200).cumsum() + 100,
                'volume': np.random.randint(100, 10000, 200)
            })

    executor_client = MockClient()
    ohlcv_fetcher = MockFetcher()

    drawdown_guard = DrawdownGuard()
    consensus_engine = ConsensusEngine()

    mathematician = MathematicianAgent()
    physicist = PhysicistAgent()
    cryptographer = CryptographerAgent()
    linguist = LinguistAgent(news_interval_seconds=300)
    executor = ExecutorAgent(executor_client, consensus_engine, symbol)

    stop_event = asyncio.Event()
    bg_tasks = []
    if enable_sentiment:
        bg_tasks.append(asyncio.create_task(linguist.start_background_feed(symbol, stop_event)))
        logger.info("[Background] Linguist News Poller started.")

    write_insight("READY", {"symbol": symbol, "style": trading_style, "loop": loop_interval})
    
    logger.info(f"=== BOT STARTED | PAIR: {symbol} | STYLE: {trading_style.upper()} | LOOP: {loop_interval}s ===")
    
    try:
        while not stop_event.is_set():
            logger.info("--- Memulai Siklus Analisis Baru ---")
            
            is_allowed, reason = drawdown_guard.is_trading_allowed()
            if not is_allowed:
                logger.warning("[DrawdownGuard] HOLD: %s", reason)
                write_insight("CIRCUIT_BREAKER_ACTIVE", {"reason": reason})
                await asyncio.sleep(60)
                continue

            candles = await ohlcv_fetcher.fetch()
            
            logger.info("Menjalankan perhitungan agen secara paralel...")
            math_sig, phys_sig, nlp_sig = await asyncio.gather(
                mathematician.analyze(candles),
                physicist.analyze(candles),
                linguist.analyze(symbol) if enable_sentiment else linguist._empty_signal()
            )
            
            crypto_sig = await cryptographer.analyze(candles, math_sig)

            signals_dict = {
                "mathematician": math_sig,
                "physicist": phys_sig,
                "cryptographer": crypto_sig,
                "linguist": nlp_sig
            }

            result = await executor.execute_consensus(signals_dict)
            
            write_insight("ANALYSIS_COMPLETE", result)

            logger.info("Siklus selesai. Menunggu %s detik...", loop_interval)
            await asyncio.sleep(loop_interval)

    except asyncio.CancelledError:
        logger.info("Main loop dibatalkan (Shutdown signal).")
    except Exception as e:
        logger.exception("Terjadi Critical Error di Main Loop: %s", e)
    finally:
        logger.info("=== SHUTTING DOWN ===")
        write_insight("BOT_STOPPED", {})
        stop_event.set()
        for task in bg_tasks:
            task.cancel()
        await asyncio.gather(*bg_tasks, return_exceptions=True)

if __name__ == "__main__":
    import sys
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBot dihentikan oleh user (Ctrl+C).")