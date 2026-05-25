import logging
import asyncio
import aiohttp
import pandas as pd
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)

class GatewayClient:
    """
    Antarmuka komunikasi antara Python Engine dan Go Data Gateway.
    Menggantikan koneksi langsung ke CEX dengan API HTTP lokal yang latensinya <1ms.
    """
    # PERBAIKAN: Gunakan 127.0.0.1 menggantikan localhost untuk menghindari isu IPv6 di Windows
    def __init__(self, base_url: str = "http://127.0.0.1:7890"):
        self.base_url = base_url
        self.headers = {"Content-Type": "application/json"}

    async def _safe_get(self, endpoint: str, params: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Lapisan pelindung untuk permintaan HTTP lokal."""
        url = f"{self.base_url}{endpoint}"
        try:
            async with aiohttp.ClientSession(headers=self.headers) as session:
                async with session.get(url, params=params, timeout=5) as response:
                    if response.status == 200:
                        return await response.json()
                    else:
                        logger.error(f"[GatewayClient] HTTP {response.status} from {url}")
                        return None
        except aiohttp.ClientConnectorError:
            logger.critical(f"[GatewayClient] Koneksi ditolak. Pastikan Go Gateway berjalan di {self.base_url}")
            return None
        except asyncio.TimeoutError:
            logger.error(f"[GatewayClient] Timeout saat mengakses {url}")
            return None
        except Exception as e:
            logger.error(f"[GatewayClient] Kesalahan tidak terduga: {e}")
            return None

    async def fetch_ohlcv(self, symbol: str, interval: str = "5m", limit: int = 100) -> Optional[pd.DataFrame]:
        """Menarik data kandelar yang sudah dinormalisasi oleh Go Gateway."""
        params = {
            "symbol": symbol,
            "interval": interval,
            "limit": limit
        }
        
        data = await self._safe_get("/api/ohlcv", params)
        if not data or "candles" not in data:
            return None
            
        candles = data["candles"]
        if not candles:
            return None

        # Format ekspektasi dari Go: [{"timestamp":..., "open":..., "high":..., "low":..., "close":..., "volume":...}]
        df = pd.DataFrame(candles)
        df['timestamp'] = pd.to_datetime(df['timestamp'], unit='ms')
        
        # Konversi tipe data tegas untuk kalkulasi matriks
        for col in ['open', 'high', 'low', 'close', 'volume']:
            df[col] = df[col].astype(float)
            
        return df

    async def fetch_open_interest(self, symbol: str) -> Optional[float]:
        """Mendapatkan nilai Open Interest teraktual."""
        params = {"symbol": symbol}
        data = await self._safe_get("/api/oi", params)
        
        if data and "oi" in data:
            return float(data["oi"])
        return None

    async def fetch_whale_ratio(self, symbol: str) -> Optional[float]:
        """
        Mendapatkan rasio Long/Short (LSR). 
        Direpresentasikan sebagai nilai desimal (>1.0 = Bullish bias, <1.0 = Bearish bias).
        """
        params = {"symbol": symbol, "period": "5min"}
        data = await self._safe_get("/api/lsr", params)
        
        if data and "lsr" in data:
            return float(data["lsr"])
        return None