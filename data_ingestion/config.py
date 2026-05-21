from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum


class ExchangeID(str, Enum):
    MEXC  = "mexc"
    BYBIT = "bybit"


class ExchangeMode(str, Enum):
    REAL = "real"
    DEMO = "demo"   # Bybit testnet / paper trading


@dataclass(frozen=True)
class ExchangeConfig:
    exchange_id: ExchangeID
    api_key:     str
    api_secret:  str
    mode:        ExchangeMode = ExchangeMode.REAL

    @property
    def testnet(self) -> bool:
        return self.mode is ExchangeMode.DEMO


def _require_env(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise EnvironmentError(
            f"Required environment variable '{key}' is not set. "
            "Check konfigurasi API Key di Dashboard."
        )
    return val


def load_mexc_config() -> ExchangeConfig:
    return ExchangeConfig(
        exchange_id=ExchangeID.MEXC,
        api_key=_require_env("MEXC_API_KEY"),
        api_secret=_require_env("MEXC_API_SECRET"),
        mode=ExchangeMode.REAL,
    )


def load_bybit_config() -> ExchangeConfig:
    raw_mode = os.environ.get("EXCHANGE_MODE", "demo").lower()
    mode = ExchangeMode.DEMO if raw_mode == "demo" else ExchangeMode.REAL
    
    if mode is ExchangeMode.DEMO:
        api_key    = _require_env("BYBIT_DEMO_API_KEY")
        api_secret = _require_env("BYBIT_DEMO_API_SECRET")
    else:
        api_key    = _require_env("BYBIT_REAL_API_KEY")
        api_secret = _require_env("BYBIT_REAL_API_SECRET")

    return ExchangeConfig(
        exchange_id=ExchangeID.BYBIT,
        api_key=api_key,
        api_secret=api_secret,
        mode=mode,
    )


def load_exchange_config() -> ExchangeConfig:
    """
    Load exchange config based on EXCHANGE env var.
    EXCHANGE=bybit  → Bybit (demo or real depending on EXCHANGE_MODE)
    EXCHANGE=mexc   → MEXC real (default)
    """
    exchange = os.environ.get("EXCHANGE", "mexc").lower()
    if exchange == "bybit":
        return load_bybit_config()
    return load_mexc_config()