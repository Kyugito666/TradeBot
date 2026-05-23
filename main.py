import os
import asyncio
import logging
from typing import Dict, Any
from dotenv import load_dotenv
import ccxt.async_support as ccxt

# Architectural Alignment: Engine Consolidation
from analytical_engine.evaluator import ConsensusEngine
from analytical_engine.liquidation import LiquidationClusterEngine
from analytical_engine.models import AnalysisSignal, Action

# Agent Subsystem
from agents.agent_mathematician import MathematicianAgent
from agents.agent_physicist import PhysicistAgent
from agents.agent_cryptographer import CryptographerAgent
from agents.agent_linguist import LinguistAgent
from agents.agent_liquidator import LiquidatorAgent
from agents.agent_executor import AgentExecutor

# External Network Boundaries
from data_ingestion.gateway_client import GatewayClient
from execution_engine.executor import TradeExecutor

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s"
)
logger = logging.getLogger("TradeBot")

async def main():
    load_dotenv()
    symbol = os.getenv("ACTIVE_SYMBOL", "BTCUSDT")
    dry_run = os.getenv("DRY_RUN", "1") == "1"
    exchange_name = os.getenv("EXCHANGE", "mexc").lower()

    logger.info(f"Starting TradeBot v2.0 | Symbol: {symbol} | DRY_RUN: {dry_run} | Exchange: {exchange_name}")

    # Exchange Interface Instantiation (Required by Executor)
    exchange_class = getattr(ccxt, exchange_name)
    exchange = exchange_class({
        'apiKey': os.getenv(f"{exchange_name.upper()}_API_KEY", ""),
        'secret': os.getenv(f"{exchange_name.upper()}_API_SECRET", ""),
        'enableRateLimit': True,
        'options': {'defaultType': 'swap'}
    })

    # Fixed Quorum parameters logic
    consensus_engine = ConsensusEngine(min_confidence=0.52, min_agree=2)
    liquidation_engine = LiquidationClusterEngine()

    # Full Agent Roster
    agents = {
        "mathematician": MathematicianAgent(),
        "physicist": PhysicistAgent(),
        "cryptographer": CryptographerAgent(),
        "linguist": LinguistAgent(),
        "liquidator": LiquidatorAgent(liquidation_engine)
    }

    agent_executor = AgentExecutor(agents)
    
    # Priority 4: Drop-in CEX connection relay routing
    data_fetcher = GatewayClient(base_url="http://localhost:7890")
    trade_executor = TradeExecutor(exchange=exchange, dry_run=dry_run)

    logger.info("Bot initialization complete. Entering main loop...")

    try:
        while True:
            try:
                # 1. High-frequency Ingestion via Local Go Gateway
                df = await data_fetcher.fetch_ohlcv(symbol, interval="5m", limit=100)
                if df is None or df.empty:
                    logger.warning("Failed to fetch OHLCV from Go Gateway. Awaiting node recovery...")
                    await asyncio.sleep(5)
                    continue

                current_price = float(df['close'].iloc[-1])
                oi = await data_fetcher.fetch_open_interest(symbol) or 0.0
                lsr = await data_fetcher.fetch_whale_ratio(symbol) or 1.0

                # 2. Parallel Agent Execution Tree
                signals_dict = await agent_executor.gather_signals(
                    df=df,
                    current_price=current_price,
                    symbol=symbol,
                    oi=oi,
                    lsr=lsr
                )

                # 3. Vote Standardization
                votes = agent_executor.extract_votes(signals_dict)

                # 4. Consensus Matrix Evaluation
                consensus_result = consensus_engine.evaluate(votes, signals_dict)

                # 5. Strictly Typed Signal Mapping & Order Execution
                if consensus_result.final_action in ("BUY", "SELL"):
                    logger.info(f"VALID SIGNAL EXECUTED: {consensus_result.final_action}")
                    
                    action_enum = Action.BUY if consensus_result.final_action == "BUY" else Action.SELL
                    
                    # Compute structural invalidation dynamically 
                    recent_high = float(df['high'].iloc[-14:].max())
                    recent_low = float(df['low'].iloc[-14:].min())
                    atr = recent_high - recent_low 
                    
                    stop_loss = recent_low - (atr * 0.5) if action_enum == Action.BUY else recent_high + (atr * 0.5)
                    
                    # Attempt cluster targeting, fallback to arbitrary R:R if target unavailable
                    liq_sig = signals_dict.get("liquidator")
                    if liq_sig and liq_sig.profile and action_enum == Action.BUY and liq_sig.profile.short_clusters:
                        take_profit = liq_sig.profile.short_clusters[0].price
                    elif liq_sig and liq_sig.profile and action_enum == Action.SELL and liq_sig.profile.long_clusters:
                        take_profit = liq_sig.profile.long_clusters[-1].price
                    else:
                        take_profit = current_price + (atr * 1.5) if action_enum == Action.BUY else current_price - (atr * 1.5)

                    signal = AnalysisSignal(
                        symbol=symbol,
                        action=action_enum,
                        entry=current_price,
                        take_profit=take_profit,
                        stop_loss=stop_loss,
                        risk_reward=round(abs(take_profit - current_price) / abs(current_price - stop_loss), 2),
                        confidence=consensus_result.confidence,
                        whale_bias="NEUTRAL",  # Derived analytically in full implementation
                        rationale=f"Consensus quorum matched: {consensus_result.buy_count} BUY vs {consensus_result.sell_count} SELL"
                    )
                    
                    await trade_executor.execute_signal(signal)
                else:
                    logger.debug("Consensus state: WAIT. No high-conviction edge identified.")

            except Exception as e:
                logger.error(f"Critical invariant breach in main loop: {e}", exc_info=True)

            await asyncio.sleep(60)
            
    finally:
        await exchange.close()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Bot shutting down gracefully.")