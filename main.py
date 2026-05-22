import asyncio
import logging
import os
import json
import sys
import socket
import urllib.request
import aiohttp
from datetime import datetime, timezone
from dotenv import load_dotenv
from aiohttp.abc import AbstractResolver

# --- Imports ---
from analytical_engine.consensus import ConsensusEngine
from agents.agent_mathematician import MathematicianAgent
from agents.agent_physicist import PhysicistAgent
from agents.agent_cryptographer import CryptographerAgent
from agents.agent_linguist import LinguistAgent
from agents.agent_executor import ExecutorAgent
from risk_engine.drawdown_guard import DrawdownGuard
from analytical_engine.ohlcv_fetcher import BybitOHLCVFetcher, MexcOHLCVFetcher

# --- Setup Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    datefmt="%H:%M:%S"
)
logger = logging.getLogger("QuantBot")

# --- Utils ---
def write_insight(status: str, detail: dict) -> None:
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
        pass

# --- Failsafe Executor ---
class DryRunExecutor:
    def __init__(self, leverage: int = 10):
        self.leverage = leverage
    async def execute_signal(self, signal) -> dict:
        logger.warning(f"EKSEKUSI (DRY RUN): {signal.action} {signal.symbol} @ {signal.entry:.2f} (TP: {signal.take_profit:.2f}, SL: {signal.stop_loss:.2f})")
        return {"id": f"dry_{int(datetime.now().timestamp())}", "status": "simulated", "price": signal.entry}

# ── HACK: DNS-OVER-HTTPS RESOLVER ─────────────────────────────────────────────
class BypassNawalaResolver(AbstractResolver):
    """
    Menghancurkan blokir DNS ISP dengan meresolve IP langsung ke Cloudflare via HTTPS.
    Ini membuat bot Anda lolos Nawala TANPA PERLU VPN.
    """
    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list:
        try:
            socket.inet_aton(host)
            return [{"hostname": host, "host": host, "port": port, "family": family, "proto": 0, "flags": 0}]
        except socket.error:
            pass
            
        try:
            # Tembak DNS Cloudflare via HTTPS (Dienkripsi, ISP tidak bisa baca/blokir)
            url = f"https://cloudflare-dns.com/dns-query?name={host}&type=A"
            req = urllib.request.Request(url, headers={"Accept": "application/dns-json"})
            
            def fetch_ip():
                with urllib.request.urlopen(req, timeout=5) as response:
                    return json.loads(response.read().decode())
            
            data = await asyncio.to_thread(fetch_ip)
            
            for answer in data.get("Answer", []):
                if answer.get("type") == 1:  # Ambil IPv4 Asli
                    real_ip = answer["data"]
                    logger.debug(f"[DoH Resolver] Sukses bongkar jalur ke {host} -> {real_ip}")
                    # aiohttp akan mengkoneksikan ke 'host' (IP), tapi menjaga SNI 'hostname' (domain asal)
                    return [{"hostname": host, "host": real_ip, "port": port, "family": family, "proto": 0, "flags": 0}]
        except Exception as e:
            logger.debug(f"[DoH Resolver] Gagal meresolve {host}: {e}")
            
        # Fallback ke sistem standar jika DoH gagal
        return [{"hostname": host, "host": host, "port": port, "family": family, "proto": 0, "flags": 0}]
        
    async def close(self) -> None:
        pass

# --- Main Flow ---
async def main():
    logger.info("=== INITIALIZING QUANT BOT ===")
    load_dotenv()
    
    raw_symbol = os.getenv("SYMBOL", "SOLUSDT")
    exchange = os.getenv("EXCHANGE", "bybit")
    is_demo = os.getenv("EXCHANGE_MODE", "demo") == "demo"
    trading_style = os.getenv("TRADING_STYLE", "daytrade")
    enable_sentiment = int(os.getenv("ENABLE_SENTIMENT", 1))
    
    symbol_bybit = raw_symbol.replace("_", "")
    if "_" not in raw_symbol and raw_symbol.endswith("USDT"):
        symbol_mexc = f"{raw_symbol[:-4]}_{raw_symbol[-4:]}"
    else:
        symbol_mexc = raw_symbol
    
    if trading_style == "scalping": loop_interval = 30
    elif trading_style == "sniper": loop_interval = 300
    else: loop_interval = 120

    # Injeksi Identitas Browser Asli & DoH Resolver
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json"
    }
    
    # KITA PAKAI DoH RESOLVER BUATAN KITA!
    stealth_resolver = BypassNawalaResolver()
    # HAPUS force_close=True, GANTI dengan keepalive agar kita hemat TLS handshake
    # Ini akan membuat MEXC mengira kita adalah browser tab yang sedang stay (idle)
    connector = aiohttp.TCPConnector(resolver=stealth_resolver, keepalive_timeout=60)
    
    async with aiohttp.ClientSession(connector=connector, headers=headers) as session:
        if exchange.lower() == "mexc":
            ohlcv_fetcher = MexcOHLCVFetcher(session)
            active_symbol = symbol_mexc
            logger.info(f"Menggunakan MEXC OHLCV Fetcher (Symbol: {active_symbol})")
        else:
            ohlcv_fetcher = BybitOHLCVFetcher(session, testnet=is_demo)
            active_symbol = symbol_bybit
            logger.info(f"Menggunakan BYBIT OHLCV Fetcher (Symbol: {active_symbol})")
            
        executor_client = DryRunExecutor(leverage=int(os.getenv("LEVERAGE", 10)))
        drawdown_guard = DrawdownGuard()
        consensus_engine = ConsensusEngine()

        mathematician = MathematicianAgent()
        physicist = PhysicistAgent()
        cryptographer = CryptographerAgent()
        linguist = LinguistAgent(news_interval_seconds=300)
        executor = ExecutorAgent(executor_client, consensus_engine, active_symbol)

        stop_event = asyncio.Event()
        bg_tasks = []
        if enable_sentiment:
            bg_tasks.append(asyncio.create_task(linguist.start_background_feed(active_symbol, stop_event)))
            logger.info("Linguist News Poller started.")

        write_insight("READY", {"symbol": active_symbol, "style": trading_style, "loop": loop_interval})
        logger.info(f"=== BOT STARTED | PAIR: {active_symbol} | STYLE: {trading_style.upper()} | LOOP: {loop_interval}s ===")
        
        try:
            while not stop_event.is_set():
                logger.info("--- Memulai Siklus Analisis Market Live ---")
                
                is_allowed, reason = drawdown_guard.is_trading_allowed()
                if not is_allowed:
                    logger.warning("HOLD: Circuit Breaker Aktif -> %s", reason)
                    write_insight("CIRCUIT_BREAKER_ACTIVE", {"reason": reason})
                    await asyncio.sleep(60)
                    continue

                # ── FETCH REAL DATA ──
                interval_map = "5m" if trading_style == "scalping" else "15m"
                try:
                    candles = await ohlcv_fetcher.fetch(active_symbol, interval=interval_map, limit=100)
                except Exception as net_err:
                    logger.error(f"Gagal koneksi jaringan ke {exchange.upper()}: {net_err}")
                    candles = None

                if candles is None or candles.empty:
                    logger.error("Market data gagal diambil. Retrying dalam 10 detik...")
                    await asyncio.sleep(10)
                    continue

                current_price = float(candles['close'].iloc[-1])
                logger.info(f"Harga Real-Time {active_symbol}: {current_price}")
                
                async def get_nlp_sig():
                    if enable_sentiment: return await linguist.analyze(active_symbol)
                    return linguist._empty_signal()

                math_sig, phys_sig, nlp_sig = await asyncio.gather(
                    mathematician.analyze(candles),
                    physicist.analyze(candles),
                    get_nlp_sig()
                )
                
                crypto_sig = await cryptographer.analyze(candles, math_sig)

                signals_dict = {
                    "mathematician": math_sig,
                    "physicist": phys_sig,
                    "cryptographer": crypto_sig,
                    "linguist": nlp_sig
                }

                result = await executor.execute_consensus(signals_dict, current_price=current_price)
                write_insight("ANALYSIS_COMPLETE", result)

                logger.info(f"Siklus selesai. Menunggu {loop_interval} detik...\n")
                await asyncio.sleep(loop_interval)

        except asyncio.CancelledError:
            logger.info("Main loop dibatalkan (Shutdown signal).")
        except Exception as e:
            logger.exception("Terjadi Critical Error di Main Loop: %s", e)
        finally:
            logger.info("=== SHUTTING DOWN ===")
            write_insight("BOT_STOPPED", {})
            stop_event.set()
            for task in bg_tasks: task.cancel()
            await asyncio.gather(*bg_tasks, return_exceptions=True)

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBot dihentikan oleh user (Ctrl+C).")