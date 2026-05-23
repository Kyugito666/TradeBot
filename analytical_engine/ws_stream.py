from __future__ import annotations

import asyncio
import json
import logging
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Optional

import websockets
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from data_ingestion.models import TickerUpdate

logger = logging.getLogger(__name__)

_BYBIT_WS_TESTNET    = "wss://stream-testnet.bybit.com/v5/public/linear"
_BYBIT_WS_MAINNET    = "wss://stream.bybit.com/v5/public/linear"
_MEXC_WS_MAINNET     = "wss://contract.mexc.com/edge"

_BACKOFF_BASE_SECS   = 1.0
_BACKOFF_MAX_SECS    = 60.0

# MEXC memerlukan heartbeat manual — server tutup koneksi jika tidak ada ping ~20s
_MEXC_PING_INTERVAL  = 15.0  # detik

class BaseTickerStream(ABC):
    def __init__(self, symbol: str, queue: asyncio.Queue[TickerUpdate]) -> None:
        self.symbol   = symbol
        self.queue    = queue
        self._running = False

    @abstractmethod
    def _ws_url(self) -> str: ...

    @abstractmethod
    async def _on_connect(self, ws: websockets.WebSocketClientProtocol) -> None: ...

    @abstractmethod
    def _parse_message(self, data: dict) -> Optional[TickerUpdate]: ...

    async def stream(self) -> None:
        self._running = True
        attempt = 0

        while self._running:
            url = self._ws_url()
            logger.info("[%s] Connecting → %s", self.__class__.__name__, url)

            try:
                async with websockets.connect(
                    url,
                    ping_interval=None,   # Disable built-in ping — kita handle manual per exchange
                    ping_timeout=None,
                    close_timeout=5,
                    max_size=2**20,
                ) as ws:
                    await self._on_connect(ws)
                    attempt = 0

                    # Jalankan heartbeat dan message reader secara concurrent
                    results = await asyncio.gather(
                        self._message_loop(ws),
                        self._heartbeat_loop(ws),
                        return_exceptions=True,
                    )
                    for r in results:
                        if isinstance(r, Exception):
                            logger.error("[%s] Inner task error: [%s] %s",
                                         self.__class__.__name__, type(r).__name__, r)

            except (ConnectionClosedError, ConnectionClosedOK) as exc:
                logger.warning("[%s] WS closed: %s", self.__class__.__name__, exc)
            except OSError as exc:
                logger.error("[%s] Network error: [%s] %s", self.__class__.__name__, type(exc).__name__, exc)
            except Exception as exc:
                logger.exception("[%s] Unexpected error: [%s] %s", self.__class__.__name__, type(exc).__name__, exc)

            if not self._running:
                break

            delay = min(_BACKOFF_BASE_SECS * (2 ** attempt), _BACKOFF_MAX_SECS)
            logger.info("[%s] Reconnect in %.1fs (attempt %d)",
                        self.__class__.__name__, delay, attempt + 1)
            await asyncio.sleep(delay)
            attempt += 1

    async def _message_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        async for raw in ws:
            if not self._running:
                return
            try:
                tick = self._parse_message(json.loads(raw))
                if tick is not None:
                    try:
                        self.queue.put_nowait(tick)
                    except asyncio.QueueFull:
                        logger.warning(
                            "[%s] Queue full — dropping tick for %s",
                            self.__class__.__name__, tick.symbol,
                        )
            except (json.JSONDecodeError, KeyError, ValueError) as exc:
                logger.debug("[%s] Parse error: %s | raw=%s",
                             self.__class__.__name__, exc, raw[:120])

    async def _heartbeat_loop(self, ws: websockets.WebSocketClientProtocol) -> None:
        """
        Kirim ping frame secara manual setiap _ping_interval detik.
        Override di subclass jika exchange butuh format ping custom (misal JSON payload).
        """
        interval = getattr(self, "_ping_interval", 20.0)
        while self._running and ws.open:
            await asyncio.sleep(interval)
            if not ws.open:
                break
            try:
                await self._send_ping(ws)
            except Exception as exc:
                logger.debug("[%s] Heartbeat error: %s", self.__class__.__name__, exc)
                break

    async def _send_ping(self, ws: websockets.WebSocketClientProtocol) -> None:
        """Default: kirim WebSocket ping frame standar."""
        await ws.ping()

    def stop(self) -> None:
        self._running = False

class BybitFuturesTickerStream(BaseTickerStream):
    def __init__(self, symbol: str, queue: asyncio.Queue[TickerUpdate], testnet: bool = True) -> None:
        super().__init__(symbol, queue)
        self._testnet = testnet

    def _ws_url(self) -> str:
        return _BYBIT_WS_TESTNET if self._testnet else _BYBIT_WS_MAINNET

    async def _on_connect(self, ws: websockets.WebSocketClientProtocol) -> None:
        sub = json.dumps({"op": "subscribe", "args": [f"tickers.{self.symbol}"]})
        await ws.send(sub)
        logger.debug("[BybitFuturesTickerStream] Subscribed to tickers.%s", self.symbol)

    def _parse_message(self, data: dict) -> Optional[TickerUpdate]:
        topic = data.get("topic", "")
        msg_type = data.get("type")

        if not topic.startswith("tickers.") or msg_type not in ("snapshot", "delta"):
            return None

        inner = data.get("data", {})
        bid_str = inner.get("bid1Price")
        ask_str = inner.get("ask1Price")

        if not bid_str or not ask_str:
            return None

        return TickerUpdate(
            symbol=inner.get("symbol", self.symbol),
            bid=float(bid_str),
            ask=float(ask_str),
            timestamp=datetime.fromtimestamp(data.get("ts", 0) / 1_000, tz=timezone.utc),
            exchange="bybit",
        )

class MexcFuturesTickerStream(BaseTickerStream):
    def __init__(self, symbol: str, queue: asyncio.Queue[TickerUpdate]) -> None:
        super().__init__(symbol, queue)
        # MEXC timeout server ~20s, kita ping setiap 15s untuk safety margin
        self._ping_interval = _MEXC_PING_INTERVAL

    def _ws_url(self) -> str:
        return _MEXC_WS_MAINNET

    async def _on_connect(self, ws: websockets.WebSocketClientProtocol) -> None:
        sub = json.dumps({"method": "sub.ticker", "param": {"symbol": self.symbol}})
        await ws.send(sub)
        logger.debug("[MexcWS] Subscribed to %s", self.symbol)

    async def _send_ping(self, ws: websockets.WebSocketClientProtocol) -> None:
        """MEXC mengharapkan JSON ping, bukan WebSocket ping frame standar."""
        await ws.send(json.dumps({"method": "ping"}))

    def _parse_message(self, data: dict) -> Optional[TickerUpdate]:
        if data.get("channel") != "push.ticker":
            return None

        inner = data.get("data", {})
        if not inner:
            return None

        return TickerUpdate(
            symbol=inner.get("symbol", self.symbol),
            bid=float(inner.get("bid1", 0)),
            ask=float(inner.get("ask1", 0)),
            timestamp=datetime.fromtimestamp(data.get("ts", 0) / 1000, tz=timezone.utc),
            exchange="mexc",
        )