"""
Smart Multi-Exchange Candle Downloader
- Auto-rotate across ALL exchanges when rate-limited
- Incremental update: reads existing parquet, appends only new candles
- All USDT pairs from all available exchanges
- Multi-timeframe: 15m, 1h, 4h, 1d
- Exponential backoff + circuit breaker per exchange
"""

import ccxt
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import os
import time
import threading
from datetime import datetime
from typing import Optional, List, Dict, Tuple
from dataclasses import dataclass, field
import logging

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("downloader")

DB_BASE_PATH = os.environ.get("BOT_DB_PATH", "/mnt/d/database")
CANDLE_DIR = os.path.join(DB_BASE_PATH, "parquet", "bigdata", "candles")
TICK_DIR = os.path.join(DB_BASE_PATH, "parquet", "bigdata", "ticks")

# All timeframes to download. 1h is base, rest are separate downloads.
TIMEFRAMES = ["1h", "15m", "4h", "1d"]

# Exchanges to use — ordered by reliability. ccxt supports 100+ exchanges.
# We pick the ones with good OHLCV history and free public API.
EXCHANGE_IDS = [
    "okx", "binance", "bybit", "mexc", "kucoin", "gate",
    "bitget", "htx", "kraken", "bitfinex", "poloniex",
    "coinex", "phemex", "bingx", "lbank",
]

# Max candle fetch per request (most exchanges support 1000)
BATCH_SIZE = 1000


@dataclass
class ExchangeState:
    """Track health of each exchange connection."""
    exchange_id: str
    instance: object = None
    fail_count: int = 0
    cooldown_until: float = 0.0
    total_fetched: int = 0
    is_loaded: bool = False


class ExchangePool:
    """
    Pool of exchange instances. Auto-rotates on rate-limit or error.
    Circuit breaker: after 3 consecutive failures, cool down for 60s.
    """

    def __init__(self, exchange_ids: List[str]):
        self._states: Dict[str, ExchangeState] = {}
        self._lock = threading.Lock()
        self._current_idx = 0

        for eid in exchange_ids:
            self._states[eid] = ExchangeState(exchange_id=eid)

        # Lazy-init first exchange
        self._ensure_loaded(exchange_ids[0])

    def _ensure_loaded(self, eid: str) -> bool:
        state = self._states[eid]
        if state.is_loaded:
            return True
        try:
            ex_class = getattr(ccxt, eid, None)
            if ex_class is None:
                log.warning(f"Exchange {eid} not found in ccxt, skipping")
                state.fail_count = 999
                return False
            instance = ex_class({"enableRateLimit": True, "timeout": 15000})
            instance.load_markets()
            state.instance = instance
            state.is_loaded = True
            log.info(f"[Pool] Loaded exchange: {eid} ({len(instance.markets)} markets)")
            return True
        except Exception as e:
            log.warning(f"[Pool] Failed to load {eid}: {e}")
            state.fail_count += 1
            state.cooldown_until = time.time() + 30
            return False

    def get_available(self) -> Optional[ExchangeState]:
        """Get the next available exchange that's not in cooldown."""
        now = time.time()
        ids = list(self._states.keys())
        for _ in range(len(ids)):
            eid = ids[self._current_idx % len(ids)]
            self._current_idx += 1
            state = self._states[eid]

            if state.fail_count >= 999:
                continue  # permanently failed (not in ccxt)
            if now < state.cooldown_until:
                continue  # in cooldown

            if not state.is_loaded:
                if not self._ensure_loaded(eid):
                    continue

            return state

        # All exchanges exhausted — wait for shortest cooldown
        min_wait = min(
            (s.cooldown_until - now for s in self._states.values() if s.cooldown_until > now),
            default=5,
        )
        log.warning(f"[Pool] All exchanges in cooldown. Waiting {min_wait:.0f}s...")
        time.sleep(max(1, min_wait))
        return self.get_available()

    def report_success(self, state: ExchangeState, rows: int):
        state.fail_count = 0
        state.total_fetched += rows

    def report_failure(self, state: ExchangeState, error: Exception):
        state.fail_count += 1
        is_rate_limit = (
            isinstance(error, (ccxt.RateLimitExceeded, ccxt.DDoSProtection))
            or "rate" in str(error).lower()
            or "429" in str(error)
        )

        if is_rate_limit:
            backoff = min(120, 10 * (2 ** state.fail_count))
            state.cooldown_until = time.time() + backoff
            log.warning(
                f"[Pool] {state.exchange_id} rate-limited → cooldown {backoff}s. "
                f"Rotating to next exchange..."
            )
        elif state.fail_count >= 3:
            state.cooldown_until = time.time() + 60
            log.warning(f"[Pool] {state.exchange_id} failed {state.fail_count}x → cooldown 60s")

    def has_symbol(self, state: ExchangeState, symbol: str) -> bool:
        if not state.instance:
            return False
        return symbol in state.instance.markets

    def get_all_usdt_pairs(self) -> List[str]:
        """Collect ALL unique USDT pairs across all loaded exchanges."""
        all_pairs = set()
        for state in self._states.values():
            if state.is_loaded and state.instance:
                for sym in state.instance.markets:
                    if "/USDT" in sym and state.instance.markets[sym].get("active", False):
                        # Normalize: remove exchange-specific suffixes
                        base = sym.split("/")[0]
                        all_pairs.add(f"{base}/USDT")
        return sorted(all_pairs)


class SmartDownloader:
    """
    Downloads candle data for all USDT pairs using multi-exchange rotation.
    Supports incremental updates and multi-timeframe.
    """

    def __init__(self, max_years: int = 5):
        os.makedirs(CANDLE_DIR, exist_ok=True)
        os.makedirs(TICK_DIR, exist_ok=True)
        self.pool = ExchangePool(EXCHANGE_IDS)
        self.max_years = max_years
        self._stop = threading.Event()
        self._progress: Dict[str, str] = {}  # symbol → status

    @property
    def progress(self) -> Dict[str, str]:
        return dict(self._progress)

    def _parquet_path(self, symbol: str, timeframe: str) -> str:
        safe = symbol.replace("/", "_")
        return os.path.join(CANDLE_DIR, f"{safe}_{timeframe}.parquet")

    def _read_last_timestamp(self, path: str) -> Optional[int]:
        """Read the last timestamp from existing parquet file for incremental update."""
        if not os.path.exists(path):
            return None
        try:
            df = pd.read_parquet(path, columns=["timestamp"])
            if len(df) == 0:
                return None
            return int(df["timestamp"].max())
        except Exception:
            return None

    def _fetch_candles(
        self, symbol: str, timeframe: str, since_ms: int
    ) -> Tuple[List, str]:
        """
        Fetch candles using the exchange pool with auto-rotation.
        Returns (ohlcv_list, exchange_id_used).
        """
        all_ohlcv = []
        current_since = since_ms
        now_ms = int(time.time() * 1000)
        used_exchange = "none"

        while current_since < now_ms and not self._stop.is_set():
            state = self.pool.get_available()
            if state is None:
                break

            if not self.pool.has_symbol(state, symbol):
                # This exchange doesn't have this pair — try next
                self.pool.report_failure(state, Exception("symbol not available"))
                continue

            try:
                ohlcv = state.instance.fetch_ohlcv(
                    symbol, timeframe, since=current_since, limit=BATCH_SIZE
                )
                if not ohlcv:
                    break

                all_ohlcv.extend(ohlcv)
                current_since = ohlcv[-1][0] + 1
                used_exchange = state.exchange_id
                self.pool.report_success(state, len(ohlcv))

                # Small sleep to be nice even within rate limits
                time.sleep(0.02)

            except Exception as e:
                self.pool.report_failure(state, e)
                # Don't break — pool will rotate to next exchange
                continue

        return all_ohlcv, used_exchange

    def download_pair(self, symbol: str, timeframe: str = "1h") -> int:
        """
        Download candle data for a single pair+timeframe.
        Incremental: only fetches new candles since last known timestamp.
        Returns number of new rows added.
        """
        path = self._parquet_path(symbol, timeframe)
        last_ts = self._read_last_timestamp(path)

        if last_ts is not None:
            since_ms = last_ts + 1  # Continue from last known
            mode = "incremental"
        else:
            # From max_years ago
            since_ms = int(time.time() * 1000) - (self.max_years * 365 * 24 * 60 * 60 * 1000)
            mode = "full"

        self._progress[symbol] = f"downloading ({mode}) [{timeframe}]"
        ohlcv, exchange_used = self._fetch_candles(symbol, timeframe, since_ms)

        if not ohlcv:
            self._progress[symbol] = f"no new data [{timeframe}]"
            return 0

        df_new = pd.DataFrame(ohlcv, columns=["timestamp", "open", "high", "low", "close", "volume"])
        df_new = df_new.drop_duplicates(subset=["timestamp"]).sort_values("timestamp")

        if os.path.exists(path):
            try:
                df_existing = pd.read_parquet(path)
                df_merged = pd.concat([df_existing, df_new]).drop_duplicates(
                    subset=["timestamp"]
                ).sort_values("timestamp")
            except Exception:
                df_merged = df_new
        else:
            df_merged = df_new

        # Write with compression
        table = pa.Table.from_pandas(df_merged, preserve_index=False)
        pq.write_table(table, path, compression="snappy")

        new_count = len(df_merged) - (len(pd.read_parquet(path, columns=["timestamp"])) if os.path.exists(path) and last_ts else 0)
        actual_new = len(ohlcv)

        self._progress[symbol] = (
            f"✓ {len(df_merged)} total candles [{timeframe}] via {exchange_used} (+{actual_new} new)"
        )
        log.info(
            f"[{symbol}] Saved {len(df_merged)} candles ({timeframe}) "
            f"via {exchange_used} (+{actual_new} new) → {path}"
        )
        return actual_new

    def download_all(
        self,
        timeframes: Optional[List[str]] = None,
        target_symbol: Optional[str] = None,
    ):
        """
        Download candles for ALL USDT pairs across all exchanges.
        Multi-timeframe: downloads each TF separately.
        """
        if timeframes is None:
            timeframes = TIMEFRAMES

        if target_symbol:
            pairs = [target_symbol]
        else:
            # Load at least 3 exchanges to get a comprehensive pair list
            for eid in EXCHANGE_IDS[:5]:
                self.pool._ensure_loaded(eid)
            pairs = self.pool.get_all_usdt_pairs()

        log.info(f"[Downloader] Starting download for {len(pairs)} pairs × {len(timeframes)} timeframes")
        log.info(f"[Downloader] Max history: {self.max_years} years")
        log.info(f"[Downloader] Exchanges: {', '.join(EXCHANGE_IDS)}")

        total_new = 0
        for tf in timeframes:
            log.info(f"\n{'='*60}")
            log.info(f"[Downloader] Timeframe: {tf} — {len(pairs)} pairs")
            log.info(f"{'='*60}")

            for i, pair in enumerate(pairs):
                if self._stop.is_set():
                    log.info("[Downloader] Stop requested, halting downloads")
                    return total_new

                progress_pct = ((i + 1) / len(pairs)) * 100
                log.info(f"[{tf}] [{i+1}/{len(pairs)}] ({progress_pct:.0f}%) {pair}...")

                try:
                    n = self.download_pair(pair, tf)
                    total_new += n
                except Exception as e:
                    log.error(f"[{tf}] {pair} error: {e}")
                    self._progress[pair] = f"✗ error: {e}"

        log.info(f"\n[Downloader] DONE. Total new candles: {total_new}")
        return total_new

    def stop(self):
        self._stop.set()


# ── Legacy compatibility: keep the old function signature ────────────────────

_global_downloader: Optional[SmartDownloader] = None


def get_downloader(max_years: int = 5) -> SmartDownloader:
    global _global_downloader
    if _global_downloader is None:
        _global_downloader = SmartDownloader(max_years=max_years)
    return _global_downloader


def download_history(
    exchange_id: str = "okx",
    timeframe: str = "1h",
    limit_days: int = 365,
    target_symbol: str = None,
):
    """Legacy function — redirects to SmartDownloader."""
    dl = get_downloader(max_years=max(1, limit_days // 365))
    dl.download_all(timeframes=[timeframe], target_symbol=target_symbol)
