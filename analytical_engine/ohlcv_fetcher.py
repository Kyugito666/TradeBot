from __future__ import annotations

import logging
from typing import Optional

import aiohttp
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = aiohttp.ClientTimeout(total=10, connect=5)

class MexcOHLCVFetcher:
    def __init__(self, session: aiohttp.ClientSession) -> None:
        self._session = session
        self._base = "https://contract.mexc.com/api/v1/contract/kline"
        self._intv_map = {
            "1m": "Min1", "3m": "Min3", "5m": "Min5", "15m": "Min15", 
            "30m": "Min30", "1h": "Min60", "2h": "Hour2", "4h": "Hour4", "1d": "Day1"
        }

    async def fetch(self, symbol: str, interval: str = "5m", limit: int = 100) -> Optional[pd.DataFrame]:
        url = f"{self._base}/{symbol}"
        params = {"interval": self._intv_map.get(interval, "Min5")}

        try:
            async with self._session.get(url, params=params, timeout=_DEFAULT_TIMEOUT) as resp:
                resp.raise_for_status()
                payload = await resp.json()
                
            data = payload.get("data", {})
            if not data or not data.get("time"):
                logger.warning("[MexcOHLCV] Empty response for %s", symbol)
                return None
                
            df = pd.DataFrame({
                "time": data.get("time", []),
                "open": data.get("open", []),
                "high": data.get("high", []),
                "low": data.get("low", []),
                "close": data.get("close", []),
                "volume": data.get("vol", [])
            })
            
            df["timestamp"] = pd.to_datetime(df["time"].astype(int), unit="s", utc=True)
            df = df.set_index("timestamp")[["open", "high", "low", "close", "volume"]]
            df = df.apply(pd.to_numeric, errors="coerce").dropna()
            
            df = df.sort_index()
            
            if len(df) > limit:
                df = df.iloc[-limit:]
                
            return df
            
        except Exception as exc:
            logger.error("[MexcOHLCV] Fetch error: %s", exc)
            return None


class MockOHLCVFetcher:
    """
    Menghasilkan OHLCV dummy (random walk) untuk testing tanpa koneksi internet.
    """
    def __init__(self, seed_price: float = 65000.0, volatility: float = 100.0) -> None:
        self._current_price = seed_price
        self._volatility = volatility

    async def fetch(self, symbol: str, interval: str = "5m", limit: int = 100) -> Optional[pd.DataFrame]:
        now = pd.Timestamp.utcnow()
        times = [now - pd.Timedelta(minutes=5 * i) for i in range(limit)]
        times.reverse()
        
        data = []
        price = self._current_price
        
        for t in times:
            open_p = price
            close_p = open_p + np.random.normal(0, self._volatility)
            high_p = max(open_p, close_p) + abs(np.random.normal(0, self._volatility / 2))
            low_p = min(open_p, close_p) - abs(np.random.normal(0, self._volatility / 2))
            vol = abs(np.random.normal(100, 50))
            
            data.append({
                "timestamp": t,
                "open": open_p,
                "high": high_p,
                "low": low_p,
                "close": close_p,
                "volume": vol
            })
            price = close_p
            
        self._current_price = price
        
        df = pd.DataFrame(data).set_index("timestamp")
        return df


class BybitOHLCVFetcher:
    _INTV_MAP = {
        "1m": "1", "3m": "3", "5m": "5", "15m": "15",
        "30m": "30", "1h": "60", "2h": "120", "4h": "240", "1d": "D"
    }

    def __init__(self, session: aiohttp.ClientSession, testnet: bool = False) -> None:
        self._session = session
        # BYPASS GEO-BLOCK: Gunakan api.bytick.com untuk mainnet, api-testnet untuk demo
        if testnet:
            self._base = "https://api-testnet.bybit.com/v5/market/kline"
        else:
            self._base = "https://api.bytick.com/v5/market/kline"

    async def fetch(self, symbol: str, interval: str = "5m", limit: int = 100) -> Optional[pd.DataFrame]:
        params = {
            "category": "linear",
            "symbol":   symbol.replace("_", ""),   # BTC_USDT → BTCUSDT
            "interval": self._INTV_MAP.get(interval, "5"),
            "limit":    limit,
        }
        try:
            async with self._session.get(self._base, params=params, timeout=_DEFAULT_TIMEOUT) as resp:
                resp.raise_for_status()
                payload = await resp.json()

            if payload.get("retCode") != 0:
                logger.error("[BybitOHLCV] API error: %s", payload.get("retMsg"))
                return None

            rows = payload["result"]["list"]   # newest first
            if not rows:
                logger.warning("[BybitOHLCV] Empty kline list for %s", symbol)
                return None

            df = pd.DataFrame(rows, columns=["time", "open", "high", "low", "close", "volume", "turnover"])
            df = df[["time", "open", "high", "low", "close", "volume"]]
            df["timestamp"] = pd.to_datetime(df["time"].astype(int), unit="ms", utc=True)
            df = df.set_index("timestamp")[["open", "high", "low", "close", "volume"]]
            df = df.apply(pd.to_numeric, errors="coerce").dropna()
            df = df.iloc[::-1]   # sort ascending (oldest first)
            logger.debug("[BybitOHLCV] Fetched %d candles for %s", len(df), symbol)
            return df

        except Exception as exc:
            logger.error("[BybitOHLCV] Fetch error: %s", exc)
            return None