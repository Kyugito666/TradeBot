from __future__ import annotations

import logging
from typing import Type

import aiohttp
import ccxt.async_support as ccxt

from .config import ExchangeConfig, ExchangeID, ExchangeMode

logger = logging.getLogger(__name__)

_EXCHANGE_CLASS_MAP: dict[ExchangeID, Type[ccxt.Exchange]] = {
    ExchangeID.MEXC:  ccxt.mexc,
    ExchangeID.BYBIT: ccxt.bybit,
}


async def build_async_exchange(config: ExchangeConfig) -> ccxt.Exchange:
    cls = _EXCHANGE_CLASS_MAP.get(config.exchange_id)
    if cls is None:
        raise ValueError(f"Unsupported exchange: {config.exchange_id!r}")

    options: dict = {
        "defaultType":             "swap",
        "adjustForTimeDifference": True,
        "recvWindow":              60000,  # Toleransi delay 60 detik untuk bypass error timestamp MEXC
    }

    if config.exchange_id is ExchangeID.BYBIT and config.mode is ExchangeMode.DEMO:
        options["sandboxMode"] = True

    exchange: ccxt.Exchange = cls({
        "apiKey":          config.api_key,
        "secret":          config.api_secret,
        "enableRateLimit": True,
        "timeout":         30000, 
        "options":         options,
    })

    # Injeksi DNS resolver handal buat ngindarin bug IPv6 Windows
    connector = aiohttp.TCPConnector(resolver=aiohttp.DefaultResolver())
    exchange.session = aiohttp.ClientSession(connector=connector, trust_env=True)

    if config.exchange_id is ExchangeID.BYBIT:
        if config.mode is ExchangeMode.DEMO:
            exchange.set_sandbox_mode(True)
            logger.warning(
                "[ccxt] %s | mode=DEMO (testnet) — virtual funds only",
                config.exchange_id.value,
            )
        else:
            # Bypass Geo-block Indonesia menggunakan bytick.com
            exchange.hostname = 'api.bytick.com'
            logger.warning(
                "[ccxt] %s | mode=REAL (mainnet) — LIVE FUNDS EXPOSED | hostname=%s",
                config.exchange_id.value, exchange.hostname,
            )
    elif config.exchange_id is ExchangeID.MEXC:
        logger.warning(
            "[ccxt] %s | mode=REAL (mainnet) — LIVE FUNDS EXPOSED",
            config.exchange_id.value,
        )

    try:
        await exchange.load_markets()
        logger.info(
            "[ccxt] %s | markets loaded | instruments=%d",
            config.exchange_id.value,
            len(exchange.markets),
        )
    except ccxt.AuthenticationError as exc:
        await exchange.close()
        raise RuntimeError(
            f"Authentication failed for {config.exchange_id.value}. "
            "Verifikasi API key, secret, dan whitelist IP."
        ) from exc
    except ccxt.NetworkError as exc:
        await exchange.close()
        raise RuntimeError(f"Network error during market load: {exc}") from exc
    except Exception as exc:
        await exchange.close()
        raise RuntimeError(f"Unexpected error during exchange init: {exc}") from exc

    return exchange