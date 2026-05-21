from __future__ import annotations

import asyncio
import logging
import os
import signal as _signal
import json
from datetime import datetime, timezone
from typing import Optional

import aiohttp
import aiosqlite
from dotenv import load_dotenv

from data_ingestion import (
    BybitFuturesRestFetcher,
    build_async_exchange,
    load_exchange_config,
)
from data_ingestion.models import OpenInterest, WhaleRatio, TickerUpdate
import ccxt.async_support as ccxt

from analytical_engine import (
    Action,
    AnalysisSignal,
    LiquidationClusterEngine,
    SignalEvaluator,
)
from analytical_engine.ws_stream import MexcFuturesTickerStream
from analytical_engine.ohlcv_fetcher import MexcOHLCVFetcher, MockOHLCVFetcher, BybitOHLCVFetcher
from execution_engine.executor import ExecutionResult, TradeExecutor

# REST fallback ticker
_MEXC_TICKER_URL = "https://contract.mexc.com/api/v1/contract/ticker"
_TICKER_POLL_INTERVAL = 5.0   # detik

load_dotenv()

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("main")

SYMBOL         = os.environ.get("SYMBOL",        "BTCUSDT")
TRADING_STYLE  = os.environ.get("TRADING_STYLE", "sniper")
OI_INTERVAL    = int(os.environ.get("OI_INTERVAL",    "60"))
LOOP_INTERVAL  = int(os.environ.get("LOOP_INTERVAL",  "300"))
OHLCV_LIMIT    = int(os.environ.get("OHLCV_LIMIT",    "100"))
USE_MOCK_OHLCV = os.environ.get("USE_MOCK_OHLCV", "0") == "1"
RISK_PCT       = float(os.environ.get("RISK_PCT",     "0.01"))
LEVERAGE       = int(os.environ.get("LEVERAGE",       "10"))
DRY_RUN        = os.environ.get("DRY_RUN",  "0") == "1"
DB_PATH        = os.environ.get("DB_PATH",  "bot_state.db")


# ── Helper Fungsi Untuk Update AI Insight Secara Real-Time ──
def write_insight(trend: str, bias: str, advice: str, status: str):
    try:
        ts = datetime.now(tz=timezone.utc).strftime("%H:%M:%S") + " UTC"
        data = {
            "timestamp": ts,
            "trend_state": trend,
            "whale_bias": bias,
            "advice": advice,
            "signal_status": status
        }
        with open("bot_insight.json", "w") as f:
            json.dump(data, f)
    except Exception:
        pass


class LazyExchange:
    def __init__(self, config: "ExchangeConfig") -> None:  # type: ignore[name-defined]
        self._config = config
        self._exchange: Optional[ccxt.Exchange] = None
        self._lock = asyncio.Lock()

    async def _ensure_connected(self) -> ccxt.Exchange:
        async with self._lock:
            if self._exchange is None:
                logger.info("[LazyExchange] Connecting to %s for the first time…", self._config.exchange_id.value)
                self._exchange = await build_async_exchange(self._config)
            return self._exchange

    async def close(self) -> None:
        async with self._lock:
            if self._exchange is not None:
                await self._exchange.close()
                self._exchange = None
                logger.info("[LazyExchange] Exchange connection closed.")

    def __getattr__(self, name: str):
        async def _proxy(*args, **kwargs):
            ex = await self._ensure_connected()
            return await getattr(ex, name)(*args, **kwargs)
        return _proxy

    def amount_to_precision(self, symbol: str, amount: float) -> str:
        if self._exchange is None:
            raise RuntimeError("LazyExchange: not connected yet")
        return self._exchange.amount_to_precision(symbol, amount)

    def price_to_precision(self, symbol: str, price: float) -> str:
        if self._exchange is None:
            raise RuntimeError("LazyExchange: not connected yet")
        return self._exchange.price_to_precision(symbol, price)

    def cost_to_precision(self, symbol: str, cost: float) -> str:
        if self._exchange is None:
            raise RuntimeError("LazyExchange: not connected yet")
        return self._exchange.cost_to_precision(symbol, cost)

    @property
    def markets(self):
        if self._exchange is None:
            return {}
        return self._exchange.markets


class StateDB:
    def __init__(self, path: str) -> None:
        self._path = path
        self._conn: Optional[aiosqlite.Connection] = None

    async def open(self) -> "StateDB":
        self._conn = await aiosqlite.connect(self._path)
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA synchronous=FULL")
        await self._conn.execute("""
            CREATE TABLE IF NOT EXISTS active_trades (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol          TEXT    NOT NULL,
                action          TEXT    NOT NULL,
                entry_order_id  TEXT,
                sl_order_id     TEXT,
                tp_order_id     TEXT,
                position_size   REAL    NOT NULL,
                entry_price     REAL    NOT NULL,
                stop_loss       REAL    NOT NULL,
                take_profit     REAL    NOT NULL,
                confidence      REAL    NOT NULL,
                whale_bias      TEXT    NOT NULL,
                created_at      TEXT    NOT NULL
            )
        """)
        await self._conn.commit()
        logger.info("[StateDB] Opened: %s", self._path)
        return self

    async def close(self) -> None:
        if self._conn:
            await self._conn.close()
            self._conn = None
            logger.info("[StateDB] Closed.")

    async def __aenter__(self) -> "StateDB":
        return await self.open()

    async def __aexit__(self, *_) -> None:
        await self.close()

    async def save_execution(self, result: ExecutionResult) -> int:
        assert self._conn, "StateDB not open"
        sig = result.signal
        now = datetime.now(tz=timezone.utc).isoformat()

        cursor = await self._conn.execute(
            """
            INSERT INTO active_trades
                (symbol, action, entry_order_id, sl_order_id, tp_order_id,
                 position_size, entry_price, stop_loss, take_profit,
                 confidence, whale_bias, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sig.symbol,
                sig.action.value,
                result.entry_order_id,
                result.sl_order_id,
                result.tp_order_id,
                result.position_size,
                sig.entry,
                sig.stop_loss,
                sig.take_profit,
                sig.confidence,
                sig.whale_bias,
                now,
            ),
        )
        await self._conn.commit()
        row_id = cursor.lastrowid
        logger.info(
            "[StateDB] Saved trade row_id=%d | %s %s | entry=%.4f | "
            "SL=%.4f | TP=%.4f | size=%.6f",
            row_id, sig.action.value, sig.symbol,
            sig.entry, sig.stop_loss, sig.take_profit, result.position_size,
        )
        return row_id

    async def load_active_trades(self) -> list[dict]:
        assert self._conn, "StateDB not open"
        async with self._conn.execute(
            "SELECT * FROM active_trades ORDER BY id ASC"
        ) as cursor:
            rows = await cursor.fetchall()
            cols = [d[0] for d in cursor.description]
        return [dict(zip(cols, row)) for row in rows]

    async def delete_trade(self, row_id: int) -> None:
        assert self._conn, "StateDB not open"
        await self._conn.execute("DELETE FROM active_trades WHERE id = ?", (row_id,))
        await self._conn.commit()
        logger.info("[StateDB] Deleted trade row_id=%d", row_id)

    async def clear_all_trades(self) -> int:
        assert self._conn, "StateDB not open"
        cursor = await self._conn.execute("DELETE FROM active_trades")
        await self._conn.commit()
        deleted = cursor.rowcount
        if deleted > 0:
            logger.warning(
                "[StateDB] DRY_RUN startup: cleared %d stale simulated trade(s) from DB.",
                deleted,
            )
        return deleted


class AnalysisState:
    def __init__(self) -> None:
        self._lock         = asyncio.Lock()
        self.latest_oi    : Optional[OpenInterest] = None
        self.latest_whale : Optional[WhaleRatio]   = None
        self.latest_ticker: Optional[TickerUpdate] = None
        self.data_ready    = asyncio.Event()

    async def update_oi(self, oi: OpenInterest) -> None:
        async with self._lock:
            self.latest_oi = oi
            if self.latest_whale is not None and not self.data_ready.is_set():
                self.data_ready.set()
                logger.info("[AnalysisState] data_ready — OI + WhaleRatio both available.")

    async def update_whale(self, whale: WhaleRatio) -> None:
        async with self._lock:
            self.latest_whale = whale
            if self.latest_oi is not None and not self.data_ready.is_set():
                self.data_ready.set()
                logger.info("[AnalysisState] data_ready — OI + WhaleRatio both available.")

    async def update_ticker(self, tick: TickerUpdate) -> None:
        async with self._lock:
            self.latest_ticker = tick

    async def snapshot(self) -> tuple[
        Optional[OpenInterest],
        Optional[WhaleRatio],
        Optional[TickerUpdate],
    ]:
        async with self._lock:
            return self.latest_oi, self.latest_whale, self.latest_ticker


async def _ws_ticker_consumer(
    queue: asyncio.Queue[TickerUpdate],
    state: AnalysisState,
) -> None:
    while True:
        tick = await queue.get()
        await state.update_ticker(tick)
        queue.task_done()


async def _rest_ticker_poller(
    session: aiohttp.ClientSession,
    state:   AnalysisState,
    stop:    asyncio.Event,
    mexc_symbol: str,
) -> None:
    timeout = aiohttp.ClientTimeout(total=5, connect=3)
    while not stop.is_set():
        try:
            async with session.get(
                _MEXC_TICKER_URL,
                params={"symbol": mexc_symbol},
                timeout=timeout,
            ) as resp:
                resp.raise_for_status()
                payload = await resp.json()

            d = payload.get("data", {})
            if d:
                bid = float(d.get("bid1", 0) or d.get("lastPrice", 0))
                ask = float(d.get("ask1", 0) or d.get("lastPrice", 0))
                if bid > 0 and ask > 0:
                    tick = TickerUpdate(
                        symbol=mexc_symbol,
                        bid=bid,
                        ask=ask,
                        timestamp=datetime.now(tz=timezone.utc),
                        exchange="mexc_rest",
                    )
                    await state.update_ticker(tick)
        except Exception:
            pass

        try:
            await asyncio.wait_for(stop.wait(), timeout=_TICKER_POLL_INTERVAL)
        except asyncio.TimeoutError:
            pass


async def _rest_poller(
    fetcher: BybitFuturesRestFetcher,
    state:   AnalysisState,
    stop:    asyncio.Event,
    bybit_symbol: str,
) -> None:
    while not stop.is_set():
        try:
            oi    = await fetcher.fetch_open_interest(bybit_symbol)
            whale = await fetcher.fetch_whale_ratio(bybit_symbol, period="5min")
            if oi:
                await state.update_oi(oi)
                logger.info("[OI]    %s oi=%.2f", oi.symbol, oi.oi)
            if whale:
                await state.update_whale(whale)
                logger.info("[WHALE] %s LSR=%.4f bias=%s", whale.symbol,
                            whale.long_short_ratio, whale.bias)
        except Exception as exc:
            logger.exception("[REST] Unexpected error in rest_poller: %s", exc)

        try:
            await asyncio.wait_for(stop.wait(), timeout=OI_INTERVAL)
        except asyncio.TimeoutError:
            pass


async def _run_cycle(
    state:         AnalysisState,
    ohlcv_fetcher: MexcOHLCVFetcher | MockOHLCVFetcher,
    engine:        LiquidationClusterEngine,
    evaluator:     SignalEvaluator,
    executor:      TradeExecutor,
    db:            StateDB,
    mexc_symbol:   str,
) -> None:
    from data_ingestion.models import OpenInterest, WhaleRatio as _WhaleRatio

    active_trades = await db.load_active_trades()
    if active_trades:
        # Tulis insight pas lagi nahan posisi biar di tab ga kosong / mati
        write_insight(
            "PAUSED (ACTIVE TRADE)", 
            "MENGAMANKAN POSISI", 
            f"Bot sedang menahan {len(active_trades)} posisi terbuka. Analisa otomatis ditunda agar tidak double entry. Tunggu sampai TP/SL kena.", 
            "WAITING_CLOSE"
        )
        logger.info(
            "[Cycle] Skipping — %d active trade(s) in DB (IDs: %s). "
            "Bot akan tidak membuka posisi baru sampai posisi sebelumnya selesai.",
            len(active_trades),
            [t["id"] for t in active_trades],
        )
        return

    oi, whale, _ticker = await state.snapshot()

    _degraded = False
    if oi is None or whale is None:
        missing = [x for x, v in [("OI", oi), ("WhaleRatio", whale)] if v is None]
        logger.warning(
            "[Cycle] DEGRADED MODE — missing: %s | "
            "Proceeding with neutral OI/Whale placeholders. ",
            ", ".join(missing),
        )
        _degraded = True
        now = datetime.now(tz=timezone.utc)
        if oi is None:
            oi = OpenInterest(
                symbol=mexc_symbol, oi=0.0, oi_value=0.0,
                timestamp=now, exchange="bybit_placeholder",
            )
        if whale is None:
            whale = _WhaleRatio(
                symbol=mexc_symbol,
                long_ratio=0.5, short_ratio=0.5, long_short_ratio=1.0,
                timestamp=now, exchange="bybit_placeholder", period="5min",
            )

    candles = await ohlcv_fetcher.fetch(mexc_symbol, interval="5m", limit=OHLCV_LIMIT)
    if candles is None or candles.empty:
        write_insight("ERROR", "-", "Gagal menarik data Candle (OHLCV). Sistem mencoba lagi pada siklus berikutnya...", "NO_DATA")
        logger.warning("[Cycle] OHLCV unavailable — skipping.")
        return

    profile = engine.build_profile(
        candles=candles,
        oi_contracts=oi.oi,
        lsr=whale.long_short_ratio,
        symbol=mexc_symbol,
    )
    if profile is None:
        write_insight("ERROR", "-", "Gagal memproses data likuidasi (Cluster Profile).", "ERROR_PROFILE")
        logger.warning("[Cycle] Cluster profile build failed — skipping.")
        return

    logger.info(
        "[Cycle] Profile | price=%.2f ATR=%.2f long_clusters=%d short_clusters=%d",
        profile.current_price, profile.atr,
        len(profile.long_clusters), len(profile.short_clusters),
    )

    signal: AnalysisSignal = evaluator.evaluate(
        profile=profile,
        whale_lsr=whale.long_short_ratio,
        whale_bias=whale.bias,
        candles=candles,
        trading_style=TRADING_STYLE
    )

    # Tulis hasil langsung dari property Evaluator
    try:
        with open("bot_insight.json", "w") as f:
            json.dump(evaluator.latest_insight, f)
    except Exception as e:
        logger.error(f"[Cycle] Failed to save AI insight: {e}")

    logger.info(
        "[Cycle] Signal | action=%s confidence=%.3f RR=%.2f | %s",
        signal.action.value, signal.confidence, signal.risk_reward, signal.rationale,
    )

    if signal.action is Action.WAIT:
        return

    result: ExecutionResult = await executor.execute_signal(signal)

    if not result.success:
        logger.warning("[Cycle] Execution failed: %s", result.error)
        return

    if result.signal.action is Action.WAIT:
        return

    try:
        await db.save_execution(result)
    except Exception as exc:
        logger.error(
            "[Cycle] CRITICAL — order live but DB persist failed. "
            "entry_id=%s sl_id=%s | error: %s",
            result.entry_order_id, result.sl_order_id, exc,
        )


async def main() -> None:
    # Sedetik bot di-start, insight langsung kita tulis "BOOTING"
    write_insight("STARTING UP", "-", "Bot baru dijalankan. Menghubungkan sistem ke database dan exchange...", "BOOTING")
    
    config   = load_exchange_config()
    exchange = LazyExchange(config)
    logger.info(
        "[main] LazyExchange initialized | exchange=%s mode=%s",
        config.exchange_id.value, config.mode.value,
    )

    stop_flag = asyncio.Event()
    loop      = asyncio.get_running_loop()
    try:
        for sig in (_signal.SIGINT, _signal.SIGTERM):
            loop.add_signal_handler(sig, _handle_shutdown, sig, stop_flag)
    except NotImplementedError:
        def _windows_handler(signum, frame):
            loop.call_soon_threadsafe(_handle_shutdown, signum, stop_flag)
        _signal.signal(_signal.SIGINT,  _windows_handler)
        _signal.signal(_signal.SIGTERM, _windows_handler)

    BYBIT_SYMBOL = SYMBOL.replace("_", "")
    MEXC_SYMBOL  = SYMBOL

    logger.info(
        "Bot starting | mexc_symbol=%s | bybit_symbol=%s | loop=%ds | mock_ohlcv=%s | dry_run=%s | style=%s",
        MEXC_SYMBOL, BYBIT_SYMBOL, LOOP_INTERVAL, USE_MOCK_OHLCV, DRY_RUN, TRADING_STYLE,
    )

    connector = aiohttp.TCPConnector(resolver=aiohttp.DefaultResolver())
    async with aiohttp.ClientSession(connector=connector) as http_session:
        rest_fetcher = BybitFuturesRestFetcher(http_session, testnet=config.testnet)
        await rest_fetcher.probe_and_init()

        ohlcv_fetcher: MexcOHLCVFetcher | MockOHLCVFetcher | BybitOHLCVFetcher
        if USE_MOCK_OHLCV:
            ohlcv_fetcher = MockOHLCVFetcher(seed_price=65_000.0)
            logger.warning("[main] MockOHLCVFetcher active — data is synthetic")
        else:
            ohlcv_fetcher = BybitOHLCVFetcher(http_session, testnet=False)
            logger.info("[main] BybitOHLCVFetcher active — public endpoint, no auth required")

        engine    = LiquidationClusterEngine()
        evaluator = SignalEvaluator()
        executor = TradeExecutor(exchange, risk_pct=RISK_PCT, dry_run=DRY_RUN, leverage=LEVERAGE)

        async with StateDB(DB_PATH) as db:
            recovered = await db.load_active_trades()
            if recovered:
                if DRY_RUN:
                    await db.clear_all_trades()
                else:
                    stale_dryrun = [t for t in recovered if not t.get("entry_order_id")]
                    real_trades  = [t for t in recovered if t.get("entry_order_id")]

                    if stale_dryrun:
                        logger.warning(
                            "[main] Clearing %d stale DRY RUN trade(s) from DB "
                            "(entry_order_id=None — no real exchange orders).",
                            len(stale_dryrun),
                        )
                        for t in stale_dryrun:
                            await db.delete_trade(t["id"])

                    if real_trades:
                        logger.warning(
                            "[main] %d real unreconciled trade(s) found in DB on startup. "
                            "IDs: %s — manual reconciliation required (Phase 4).",
                            len(real_trades), [t["id"] for t in real_trades],
                        )
                    elif not stale_dryrun:
                        logger.info("[main] DB clean — no unreconciled trades on startup.")
            else:
                logger.info("[main] DB clean — no unreconciled trades on startup.")

            state        = AnalysisState()
            ticker_queue: asyncio.Queue[TickerUpdate] = asyncio.Queue(maxsize=1_000)

            try:
                free_usdt = await executor.check_balance()
                if free_usdt > 0:
                    logger.info(
                        "[main] ✓ Exchange connected | exchange=%s mode=%s | free_USDT=%.2f",
                        config.exchange_id.value, config.mode.value, free_usdt,
                    )
                else:
                    logger.warning(
                        "[main] ✓ Exchange connected | exchange=%s mode=%s | free_USDT=0.00 "
                        "— Jika saldo ada di Bybit, pastikan akun pakai Unified Margin. "
                        "Demo account: topup via https://testnet.bybit.com",
                        config.exchange_id.value, config.mode.value,
                    )
            except Exception as exc:
                logger.warning(
                    "[main] ✗ Startup balance check failed (dry_run=%s) — "
                    "verify API key, IP whitelist, and account type. Error: %s",
                    DRY_RUN, exc,
                )

            background_tasks = [
                asyncio.create_task(_rest_poller(rest_fetcher, state, stop_flag, BYBIT_SYMBOL), name="rest_poller"),
                asyncio.create_task(stop_flag.wait(),                                           name="stop_sentinel"),
            ]

            _initial_timeout = OI_INTERVAL * 2
            logger.info(
                "[main] Waiting for initial OI + WhaleRatio (timeout=%ds)…",
                _initial_timeout,
            )
            # Tulis status ke AI Insight waktu bot nunggu fetch Bybit
            write_insight("LOADING DATA", "-", "Menunggu data Open Interest & Whale Ratio terkirim dari Bybit...", "FETCHING")
            
            try:
                await asyncio.wait_for(
                    asyncio.shield(state.data_ready.wait()),
                    timeout=float(_initial_timeout),
                )
                write_insight("ANALYZING", "READY", "Data diterima. Memulai siklus analisa pasar.", "READY")
            except asyncio.TimeoutError:
                logger.warning(
                    "[main] Timeout waiting for initial data after %ds. "
                    "Bybit REST may be unreachable. Proceeding — cycle will retry.",
                    _initial_timeout,
                )

            logger.info("[main] Entering main loop | cycle=%ds", LOOP_INTERVAL)
            while not stop_flag.is_set():
                try:
                    await _run_cycle(
                        state, ohlcv_fetcher, engine, evaluator, executor, db, BYBIT_SYMBOL
                    )
                except Exception as exc:
                    logger.exception("[main] Unhandled error in _run_cycle: %s", exc)

                retry_interval = LOOP_INTERVAL if state.data_ready.is_set() else OI_INTERVAL
                try:
                    await asyncio.wait_for(stop_flag.wait(), timeout=float(retry_interval))
                except asyncio.TimeoutError:
                    pass

            logger.info("[main] Stop signal received — shutting down…")
            for task in background_tasks:
                task.cancel()
            await asyncio.gather(*background_tasks, return_exceptions=True)

    await exchange.close()
    logger.info("[main] ccxt exchange connection closed.")
    logger.info("[main] Shutdown complete.")

def _handle_shutdown(sig, stop_flag: asyncio.Event) -> None:
    sig_name = sig.name if hasattr(sig, 'name') else _signal.Signals(sig).name
    logger.info("[main] Received %s — initiating graceful shutdown.", sig_name)
    stop_flag.set()

if __name__ == "__main__":
    asyncio.run(main())