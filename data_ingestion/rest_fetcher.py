from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import aiohttp

from .models import OpenInterest, WhaleRatio

logger = logging.getLogger(__name__)

_BYBIT_TESTNET   = "https://api-testnet.bybit.com"
_BYBIT_MAINNET   = "https://api.bytick.com"     # Alt domain anti-block
_BYBIT_MAINNET_2 = "https://api.bybit.com"      # Fallback ori domain

_DEFAULT_TIMEOUT = aiohttp.ClientTimeout(total=20, connect=5)
_MAX_RETRIES     = 3
_BACKOFF_BASE    = 1.0   
_BACKOFF_MAX     = 5.0   

_PROBE_PATH    = "/v5/market/time"         
_PROBE_TIMEOUT = aiohttp.ClientTimeout(total=6, connect=4)


class BybitFuturesRestFetcher:
    _VALID_PERIODS = frozenset(["5min", "15min", "30min", "1h", "4h", "1d"])

    def __init__(self, session: aiohttp.ClientSession, testnet: bool = True) -> None:
        self._session  = session
        self._testnet  = testnet
        self._base      = _BYBIT_MAINNET
        self._auth_base = _BYBIT_TESTNET if testnet else _BYBIT_MAINNET
        logger.info(
            "[BybitFetcher] Initialized | market_data=%s | auth=%s | testnet=%s",
            self._base, self._auth_base, testnet,
        )

    async def probe_and_init(self) -> None:
        # Susun daftar probe: bytick -> bybit -> testnet (kalau mode demo)
        candidates = [_BYBIT_MAINNET, _BYBIT_MAINNET_2]
        if self._testnet:
            candidates.append(_BYBIT_TESTNET)

        for base in candidates:
            url = f"{base}{_PROBE_PATH}"
            try:
                async with self._session.get(url, timeout=_PROBE_TIMEOUT) as resp:
                    if resp.status == 200:
                        if base != self._base:
                            logger.info(
                                "[BybitFetcher] Priority domain unreachable — switching market_data to %s",
                                base,
                            )
                            self._base = base
                        else:
                            logger.info("[BybitFetcher] Connectivity probe OK | using %s", base)
                        return
                    logger.warning("[BybitFetcher] Probe %s returned HTTP %d", base, resp.status)
            except Exception as exc:
                logger.warning(
                    "[BybitFetcher] Probe %s failed (%s) — trying next.",
                    base, type(exc).__name__,
                )

        logger.error("[BybitFetcher] All probe candidates unreachable. OI/Whale data will fail.")

    async def _get_with_retry(self, path: str, params: dict, label: str) -> Optional[dict]:
        last_exc: Optional[Exception] = None
        all_timeout = True  

        for attempt in range(1, _MAX_RETRIES + 1):
            url = f"{self._base}{path}"
            try:
                async with self._session.get(
                    url, params=params, timeout=_DEFAULT_TIMEOUT
                ) as resp:
                    resp.raise_for_status()
                    return await resp.json()

            except aiohttp.ClientResponseError as exc:
                all_timeout = False
                logger.error(
                    "[Bybit] %s HTTP %d on attempt %d/%d: %s",
                    label, exc.status, attempt, _MAX_RETRIES, exc.message,
                )
                if exc.status < 500:
                    return None
                last_exc = exc

            except (aiohttp.ClientConnectorError, aiohttp.ServerTimeoutError,
                    aiohttp.ConnectionTimeoutError, asyncio.TimeoutError) as exc:
                logger.warning(
                    "[Bybit] %s connection/timeout error on attempt %d/%d: %s",
                    label, attempt, _MAX_RETRIES, type(exc).__name__,
                )
                last_exc = exc

            except Exception as exc:
                all_timeout = False
                logger.exception("[Bybit] %s unexpected error on attempt %d/%d", label, attempt, _MAX_RETRIES)
                last_exc = exc

            if attempt < _MAX_RETRIES:
                delay = min(_BACKOFF_BASE * (2 ** (attempt - 1)), _BACKOFF_MAX)
                logger.info("[Bybit] %s retrying in %.1fs…", label, delay)
                await asyncio.sleep(delay)

        if all_timeout and self._testnet and self._base != _BYBIT_TESTNET:
            logger.warning(
                "[Bybit] %s — Mainnet blocked mid-session. Switching to %s (failover).",
                label, _BYBIT_TESTNET,
            )
            self._base = _BYBIT_TESTNET
            url = f"{self._base}{path}"
            try:
                async with self._session.get(
                    url, params=params, timeout=_DEFAULT_TIMEOUT
                ) as resp:
                    resp.raise_for_status()
                    return await resp.json()
            except Exception as exc:
                logger.error("[Bybit] %s Testnet failover failed: %s", label, exc)
                return None

        logger.error("[Bybit] %s failed after %d attempts.", label, _MAX_RETRIES)
        return None

    def _check_response(self, data: dict, label: str) -> bool:
        if data.get("retCode") != 0:
            logger.error(
                "[Bybit] %s API error | retCode=%s | msg=%s",
                label, data.get("retCode"), data.get("retMsg"),
            )
            return False
        return True

    async def fetch_open_interest(self, symbol: str, interval: str = "5min") -> Optional[OpenInterest]:
        path   = "/v5/market/open-interest"
        params = {"category": "linear", "symbol": symbol, "intervalTime": interval, "limit": 1}
        data = await self._get_with_retry(path, params, "OI")
        if not data or not self._check_response(data, "OI"): return None
        items = data["result"]["list"]
        if not items: return None
        return OpenInterest(
            symbol=symbol, oi=float(items[0]["openInterest"]), oi_value=0.0,
            timestamp=datetime.fromtimestamp(int(items[0]["timestamp"]) / 1_000, tz=timezone.utc),
            exchange="bybit"
        )

    async def fetch_whale_ratio(self, symbol: str, period: str = "5min") -> Optional[WhaleRatio]:
        if period not in self._VALID_PERIODS:
            raise ValueError(f"Invalid period '{period}'.")
        path   = "/v5/market/account-ratio"
        params = {"category": "linear", "symbol": symbol, "period": period, "limit": 1}
        data = await self._get_with_retry(path, params, "WhaleRatio")
        if not data or not self._check_response(data, "WhaleRatio"): return None
        items = data["result"]["list"]
        if not items: return None
        rec = items[0]
        buy, sell = float(rec["buyRatio"]), float(rec["sellRatio"])
        return WhaleRatio(
            symbol=symbol, long_ratio=buy, short_ratio=sell,
            long_short_ratio=(buy / sell if sell else 0.0),
            timestamp=datetime.fromtimestamp(int(rec["timestamp"]) / 1_000, tz=timezone.utc),
            exchange="bybit", period=period
        )