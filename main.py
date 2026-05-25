import os
import json
import asyncio
import logging
from datetime import datetime, timezone
from dotenv import load_dotenv
import ccxt.async_support as ccxt

from analytical_engine.evaluator import ConsensusEngine
from analytical_engine.liquidation import LiquidationClusterEngine
from analytical_engine.models import AnalysisSignal, Action

from agents.agent_mathematician import MathematicianAgent
from agents.agent_physicist import PhysicistAgent
from agents.agent_cryptographer import CryptographerAgent
from agents.agent_linguist import LinguistAgent
from agents.agent_liquidator import LiquidatorAgent
from agents.agent_executor import AgentExecutor

from data_ingestion.gateway_client import GatewayClient
from execution_engine.executor import TradeExecutor

# Logging ke file agar bisa dibaca dashboard
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
    handlers=[
        logging.StreamHandler(),          # stdout (ditangkap bot_server)
    ]
)
logger = logging.getLogger("main")


async def main():
    load_dotenv()

    symbol   = os.getenv("SYMBOL", os.getenv("ACTIVE_SYMBOL", "BTCUSDT"))
    dry_run  = os.getenv("DRY_RUN", "1") == "1"
    exchange_name = os.getenv("EXCHANGE", "mexc").lower()
    risk_pct = float(os.getenv("RISK_PCT", "0.03"))
    leverage = int(os.getenv("LEVERAGE", "10"))

    logger.info("TradeBot v2.0 | symbol=%s dry_run=%s exchange=%s risk=%.0f%%",
                symbol, dry_run, exchange_name, risk_pct * 100)

    # Exchange init
    exchange_class = getattr(ccxt, exchange_name)
    api_key    = os.getenv(f"{exchange_name.upper()}_API_KEY", "")
    api_secret = os.getenv(f"{exchange_name.upper()}_API_SECRET", "")

    exchange = exchange_class({
        'apiKey': api_key,
        'secret': api_secret,
        'enableRateLimit': True,
        'options': {'defaultType': 'swap'}
    })

    # PERBAIKAN: Menarik data saldo nyata dari bursa (tidak hardcoded 0 lagi)
    balance = 0.0
    try:
        if api_key and api_secret:
            bal_data = await exchange.fetch_balance()
            balance = bal_data.get('USDT', {}).get('free', 0.0)
    except Exception as e:
        logger.warning(f"Gagal mengambil saldo: {e}")

    logger.info("[main]   Exchange connected | exchange=%s mode=%s | free_USDT=%.2f",
                exchange_name, os.getenv("EXCHANGE_MODE", "real"), balance)

    consensus_engine   = ConsensusEngine(min_confidence=0.52, min_agree=2)
    liquidation_engine = LiquidationClusterEngine()

    agents = {
        "mathematician": MathematicianAgent(),
        "physicist":     PhysicistAgent(),
        "cryptographer": CryptographerAgent(),
        "linguist":      LinguistAgent(),
        "liquidator":    LiquidatorAgent(liquidation_engine),
    }

    agent_executor = AgentExecutor(agents)
    data_fetcher   = GatewayClient(base_url="http://127.0.0.1:7890")
    trade_executor = TradeExecutor(exchange=exchange, dry_run=dry_run,
                                   risk_pct=risk_pct, leverage=leverage)

    loop_interval = int(os.getenv("LOOP_INTERVAL", "60"))
    logger.info("Bot ready. Loop interval=%ds", loop_interval)

    try:
        while True:
            try:
                df = await data_fetcher.fetch_ohlcv(symbol, interval="5m", limit=100)
                if df is None or df.empty:
                    logger.warning("OHLCV fetch gagal — tunggu Go Gateway...")
                    await asyncio.sleep(5)
                    continue

                current_price = float(df['close'].iloc[-1])
                logger.info("Harga Real-Time %s: %.4f", symbol, current_price)

                oi  = await data_fetcher.fetch_open_interest(symbol) or 0.0
                lsr = await data_fetcher.fetch_whale_ratio(symbol)   or 1.0

                logger.info("[OI] %s oi=%.2f", symbol, oi)
                logger.info("[WHALE] %s LSR=%.4f bias=%s",
                            symbol, lsr, "LONG_HEAVY" if lsr > 1.05 else
                            "SHORT_HEAVY" if lsr < 0.95 else "NEUTRAL")

                signals_dict = await agent_executor.gather_signals(
                    df=df, current_price=current_price, symbol=symbol,
                    oi=oi, lsr=lsr
                )
                votes            = agent_executor.extract_votes(signals_dict)
                consensus_result = consensus_engine.evaluate(votes, signals_dict)

                # PERBAIKAN: Menampilkan bukti bahwa seluruh tim agen bekerja memberikan suaranya
                vote_details = [f"{v.agent_name}={v.direction}" for v in votes]
                logger.info(f"[Team Agents] Suara terkumpul: {', '.join(vote_details)}")

                # Menyiapkan variabel default untuk panel AI Insight
                take_profit = 0.0
                stop_loss = 0.0
                ai_advice = f"Consensus: {consensus_result.buy_count} BUY vs {consensus_result.sell_count} SELL"

                if consensus_result.final_action in ("BUY", "SELL"):
                    action_enum = Action.BUY if consensus_result.final_action == "BUY" else Action.SELL

                    recent_high = float(df['high'].iloc[-14:].max())
                    recent_low  = float(df['low'].iloc[-14:].min())
                    atr         = recent_high - recent_low

                    stop_loss = (recent_low  - atr * 0.5 if action_enum == Action.BUY
                                 else recent_high + atr * 0.5)

                    liq_sig = signals_dict.get("liquidator")
                    if liq_sig and liq_sig.profile and action_enum == Action.BUY and liq_sig.profile.short_clusters:
                        take_profit = liq_sig.profile.short_clusters[0].price
                    elif liq_sig and liq_sig.profile and action_enum == Action.SELL and liq_sig.profile.long_clusters:
                        take_profit = liq_sig.profile.long_clusters[-1].price
                    else:
                        take_profit = (current_price + atr * 1.5 if action_enum == Action.BUY
                                       else current_price - atr * 1.5)

                    rr = round(abs(take_profit - current_price) / max(abs(current_price - stop_loss), 1e-8), 2)

                    signal = AnalysisSignal(
                        symbol=symbol,
                        action=action_enum,
                        entry=current_price,
                        take_profit=take_profit,
                        stop_loss=stop_loss,
                        risk_reward=rr,
                        confidence=consensus_result.confidence,
                        whale_bias="LONG_HEAVY" if lsr > 1.05 else "SHORT_HEAVY" if lsr < 0.95 else "NEUTRAL",
                        rationale=ai_advice,
                        timestamp=datetime.now(timezone.utc),
                    )

                    logger.info("[Executor] entry=%.4f SL=%.4f TP=%.4f RR=%.2f conf=%.3f",
                                signal.entry, signal.stop_loss, signal.take_profit,
                                signal.risk_reward, signal.confidence)
                    logger.info("[Executor]   %s %s", consensus_result.final_action, symbol)
                    
                    ai_advice = f"Aksi {consensus_result.final_action} disetujui! Mengeksekusi order..."
                    await trade_executor.execute_signal(signal)
                else:
                    logger.debug("Consensus: WAIT")

                # PERBAIKAN: Menyimpan otak AI ke file JSON secara berkala agar bisa dirender visual oleh Dashboard
                insight_data = {
                    "symbol": symbol,
                    "last_price": current_price,
                    "open_interest": oi,
                    "lsr_val": lsr,
                    "trend_state": "BULLISH" if lsr > 1.05 else "BEARISH" if lsr < 0.95 else "RANGING",
                    "whale_bias": "LONG_HEAVY" if lsr > 1.05 else "SHORT_HEAVY" if lsr < 0.95 else "NEUTRAL",
                    "signal_status": consensus_result.final_action,
                    "advice": ai_advice,
                    "timestamp": datetime.now().strftime("%H:%M:%S"),
                    "balance": balance,
                    "entry_target": current_price if consensus_result.final_action != "WAIT" else 0,
                    "tp_target": take_profit,
                    "sl_target": stop_loss
                }
                
                try:
                    with open("bot_insight.json", "w", encoding="utf-8") as f:
                        json.dump(insight_data, f)
                except Exception as e:
                    logger.error(f"Gagal menulis insight: {e}")

            except Exception as e:
                logger.error("Error di main loop: %s", e, exc_info=True)

            await asyncio.sleep(loop_interval)

    finally:
        await exchange.close()
        logger.info("Bot shutdown.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass