from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Optional

import ccxt.async_support as ccxt
from ccxt.base.errors import (
    ExchangeError,
    InsufficientFunds,
    NetworkError,
    RateLimitExceeded,
)

from analytical_engine import Action, AnalysisSignal

logger = logging.getLogger(__name__)

_RISK_PCT_DEFAULT: float = 0.01
_MAX_RETRIES:      int   = 3
_RETRY_BASE_DELAY: float = 1.0
_MIN_NOTIONAL:     float = 5.0
_PRICE_EPSILON:    float = 1e-8


@dataclass(frozen=True, slots=True)
class ExecutionResult:
    signal:         AnalysisSignal
    success:        bool
    entry_order_id: Optional[str]   = field(default=None)
    sl_order_id:    Optional[str]   = field(default=None)
    tp_order_id:    Optional[str]   = field(default=None)
    position_size:  float           = field(default=0.0)
    error:          Optional[str]   = field(default=None)


class TradeExecutor:
    def __init__(
        self,
        exchange: ccxt.Exchange,
        risk_pct: float = _RISK_PCT_DEFAULT,
        dry_run:  bool  = False,
        leverage: int   = 10,
    ) -> None:
        # LIMIT MARGIN DIBUKA SAMPAI 100% (1.0)
        if not (0 < risk_pct <= 1.0):
            raise ValueError(f"risk_pct={risk_pct} out of sane bounds (0, 1.0]")
        if not (1 <= leverage <= 125):
            raise ValueError(f"leverage={leverage} out of sane bounds [1, 125]")
        self._exchange = exchange
        self._risk_pct = risk_pct
        self._dry_run  = dry_run
        self._leverage = leverage

    async def check_balance(self) -> float:
        return await self._fetch_free_usdt()

    async def execute_signal(self, signal: AnalysisSignal) -> ExecutionResult:
        if signal.action is Action.WAIT:
            logger.debug("[Executor] WAIT — no action. %s", signal.rationale)
            return ExecutionResult(signal=signal, success=True)

        exchange_id = self._exchange.id

        ccxt_symbol = signal.symbol
        if "/" not in ccxt_symbol:
            base_coin = ccxt_symbol.replace("_", "").replace("USDT", "")
            ccxt_symbol = f"{base_coin}/USDT:USDT"

        logger.info(
            "[Executor] ── %s %s (%s) ─────────────────────────────",
            signal.action.value, signal.symbol, ccxt_symbol,
        )
        logger.info(
            "[Executor] entry=%.4f  SL=%.4f  TP=%.4f  RR=%.2f  conf=%.3f",
            signal.entry, signal.stop_loss, signal.take_profit,
            signal.risk_reward, signal.confidence,
        )

        _SIMULATED_DRY_BALANCE = 10_000.0

        try:
            free_usdt = await self._fetch_free_usdt()
        except (ExchangeError, NetworkError) as exc:
            if self._dry_run:
                logger.warning("[Executor] DRY RUN — balance fetch failed: %s. Pakai simulated %.0f USDT.", exc, _SIMULATED_DRY_BALANCE)
                free_usdt = _SIMULATED_DRY_BALANCE
            else:
                msg = f"Balance fetch failed: {exc}"
                logger.error("[Executor] %s", msg)
                return ExecutionResult(signal=signal, success=False, error=msg)
        except Exception as exc:
            msg = f"Unexpected error checking balance: {exc}"
            logger.error("[Executor] %s", msg)
            return ExecutionResult(signal=signal, success=False, error=msg)

        if free_usdt <= 0:
            if self._dry_run:
                logger.warning(
                    "[Executor] DRY RUN — free USDT = 0. Using simulated %.0f USDT.",
                    _SIMULATED_DRY_BALANCE,
                )
                free_usdt = _SIMULATED_DRY_BALANCE
            else:
                msg = "InsufficientFunds: free USDT balance is zero"
                logger.warning("[Executor] %s", msg)
                return ExecutionResult(signal=signal, success=False, error=msg)

        raw_size = self._calculate_position_size(free_usdt, signal.entry, signal.stop_loss)
        if raw_size is None:
            msg = "Degenerate signal: entry == stop_loss (zero stop distance)"
            return ExecutionResult(signal=signal, success=False, error=msg)

        position_size = self._apply_exchange_precision(ccxt_symbol, raw_size)
        if position_size is None:
            msg = "Position size rounded to zero after exchange precision applied"
            logger.warning("[Executor] %s", msg)
            return ExecutionResult(signal=signal, success=False, error=msg)

        notional = position_size * signal.entry
        if notional < _MIN_NOTIONAL:
            msg = (
                f"Notional {notional:.4f} USDT below exchange minimum {_MIN_NOTIONAL} USDT. "
                f"Increase balance or widen stop."
            )
            logger.warning("[Executor] %s", msg)
            return ExecutionResult(signal=signal, success=False, error=msg)

        is_long    = signal.action is Action.BUY
        entry_side = "buy"  if is_long else "sell"
        exit_side  = "sell" if is_long else "buy"

        risk_usdt = free_usdt * self._risk_pct
        logger.info(
            "[Executor] balance=%.2f USDT | risk=%.2f USDT | size=%.6f | notional=%.2f USDT | side=%s",
            free_usdt, risk_usdt, position_size, notional, entry_side,
        )

        if self._dry_run:
            logger.warning("[Executor] DRY RUN — orders not submitted to exchange.")
            return ExecutionResult(signal=signal, success=True, position_size=position_size)

        await self._ensure_leverage(ccxt_symbol, is_long)

        entry_price_str = self._exchange.price_to_precision(ccxt_symbol, signal.entry)
        sl_price_str    = self._exchange.price_to_precision(ccxt_symbol, signal.stop_loss)
        tp_price_str    = self._exchange.price_to_precision(ccxt_symbol, signal.take_profit)

        params = {"timeInForce": "GTC"}

        # ── CHANGE: Bybit strict v5 parameters (Layer 1 Defense) ──────────────
        if exchange_id == "bybit":
            params.update({
                "stopLoss":    float(sl_price_str),
                "takeProfit":  float(tp_price_str),
                "slTriggerBy": "LastPrice",
                "tpTriggerBy": "LastPrice",
                "tpslMode":    "Full", # Wajib di v5 untuk meyakinkan whole position ditutup
                "positionIdx": 0       # Wajib jika dalam mode One-Way
            })
        elif exchange_id == "mexc":
            params.update({
                "openType": 1,
                "positionType": 1 if is_long else 2
            })

        entry_order = await self._place_order(
            label      = "ENTRY",
            order_type = "limit",
            side       = entry_side,
            symbol     = ccxt_symbol,
            amount     = position_size,
            price      = float(entry_price_str),
            params     = params,
        )
        
        if entry_order is None:
            return ExecutionResult(signal=signal, success=False, error="Entry order failed")

        entry_order_id = str(entry_order.get("id", ""))
        sl_order_id = entry_order.get("info", {}).get("stopLossOrderId")
        tp_order_id = entry_order.get("info", {}).get("takeProfitOrderId")

        # ── CHANGE: Bybit fallback verification (Layer 2 & 3 Defense) ─────────
        if exchange_id == "bybit":
            logger.info("[Executor] Melakukan verifikasi TP/SL pada Bybit pasca-order...")
            await asyncio.sleep(2.0) # Memberi jeda ke Bybit match engine
            await self._verify_and_fallback_bybit_tpsl(
                symbol=ccxt_symbol,
                is_long=is_long,
                tp_price=float(tp_price_str),
                sl_price=float(sl_price_str)
            )

# ── MEXC fallback (Layer 4 Defense - Diperbaiki untuk Hedge Mode) ─────────
        if exchange_id == "mexc":
            logger.info("[Executor] MEXC mode: Menempatkan order TP & SL terpisah...")
            
            # WAJIB: Di MEXC Hedge Mode, nutup LONG = sell positionType 1. 
            # Nutup SHORT = buy positionType 2.
            mexc_exit_pos_type = 1 if is_long else 2
            
            # SL Order
            sl_params = {
                "triggerPrice": float(sl_price_str),
                "openType": 1,                       # 1 = Isolated
                "positionType": mexc_exit_pos_type,  # Identitas posisi yang mau ditutup
                "reduceOnly": True
            }
            
            sl_order = await self._place_order(
                label      = "SL",
                order_type = "market",
                side       = exit_side,
                symbol     = ccxt_symbol,
                amount     = position_size,
                price      = None,
                params     = sl_params
            )
            if sl_order:
                sl_order_id = str(sl_order.get("id"))
                logger.info("[Executor] MEXC SL order diregistrasi: %s", sl_order_id)
            else:
                logger.error("[Executor] MEXC gagal menempatkan SL order!")

            # TP Order
            tp_params = {
                "triggerPrice": float(tp_price_str),
                "openType": 1,                       # 1 = Isolated
                "positionType": mexc_exit_pos_type,  # Identitas posisi yang mau ditutup
                "reduceOnly": True
            }

            tp_order = await self._place_order(
                label      = "TP",
                order_type = "market",
                side       = exit_side,
                symbol     = ccxt_symbol,
                amount     = position_size,
                price      = None,
                params     = tp_params
            )
            if tp_order:
                tp_order_id = str(tp_order.get("id"))
                logger.info("[Executor] MEXC TP order diregistrasi: %s", tp_order_id)
            else:
                logger.error("[Executor] MEXC gagal menempatkan TP order!")

        logger.info(
            "[Executor] ✓ Complete | %s %s %.6f @ %.4f | SL=%.4f | TP=%.4f",
            signal.action.value, ccxt_symbol, position_size,
            signal.entry, signal.stop_loss, signal.take_profit,
        )

        return ExecutionResult(
            signal         = signal,
            success        = True,
            entry_order_id = entry_order_id,
            sl_order_id    = sl_order_id or "pending",
            tp_order_id    = tp_order_id or "pending",
            position_size  = position_size,
        )

    # ── CHANGE: Metode Helper untuk Verifikasi Bybit TP/SL ────────────────────
    async def _verify_and_fallback_bybit_tpsl(
        self,
        symbol: str,
        is_long: bool,
        tp_price: float,
        sl_price: float
    ) -> None:
        """
        Layer 2 & 3 Defense. Mengecek posisi aktif, jika TP/SL tidak ada
        karena mapping CCXT gagal di Layer 1, langsung gunakan private API.
        """
        try:
            positions = await self._exchange.fetch_positions([symbol])
            open_pos = [
                p for p in positions
                if p.get("symbol") == symbol and abs(float(p.get("contracts") or 0)) > _PRICE_EPSILON
            ]

            if not open_pos:
                logger.info("[Executor] Order kemungkinan belum terisi (Limit). Tidak dapat memverifikasi/fallback position stop.")
                return

            pos = open_pos[0]
            info = pos.get("info", {})
            
            # Periksa raw data dari Bybit v5
            raw_tp = float(info.get("takeProfit") or 0)
            raw_sl = float(info.get("stopLoss") or 0)

            if raw_tp > 0 and raw_sl > 0:
                logger.info("[Executor] Layer 1 Berhasil. TP (%.4f) & SL (%.4f) terverifikasi pada posisi.", raw_tp, raw_sl)
            else:
                logger.warning("[Executor] Layer 1 Gagal/Naked Position terdeteksi. Mencoba Layer 3 (Fallback)...")
                await self._set_tp_sl_via_position_stop(symbol, is_long, tp_price, sl_price)

        except Exception as exc:
            logger.warning("[Executor] Gagal memverifikasi posisi Bybit: %s", exc)

    async def _set_tp_sl_via_position_stop(
        self,
        symbol: str,
        is_long: bool,
        tp: float,
        sl: float
    ) -> None:
        """
        Layer 3 Defense. Call /v5/position/trading-stop langsung via CCXT bridge.
        """
        try:
            if not hasattr(self._exchange, "private_post_v5_position_trading_stop"):
                logger.error("[Executor] Versi CCXT tidak mendukung private_post_v5_position_trading_stop")
                return

            # Bybit raw market id format ex: BTCUSDT
            raw_symbol = symbol.replace("/", "").replace(":", "").replace("USDTUSDT", "USDT")
            
            tp_str = self._exchange.price_to_precision(symbol, tp)
            sl_str = self._exchange.price_to_precision(symbol, sl)

            payload = {
                "category": "linear",
                "symbol": raw_symbol,
                "takeProfit": tp_str,
                "stopLoss": sl_str,
                "tpTriggerBy": "LastPrice",
                "slTriggerBy": "LastPrice",
                "tpslMode": "Full",
                "positionIdx": 0
            }

            logger.info("[Executor] Mengirim Fallback Payload: %s", payload)
            res = await self._exchange.private_post_v5_position_trading_stop(payload)
            
            if res and res.get("retCode") == 0:
                logger.info("[Executor] Fallback TP/SL berhasil diamankan.")
            else:
                logger.warning("[Executor] API merespons tapi memberikan peringatan: %s", res)
                
        except Exception as exc:
            logger.error("[Executor] Kesalahan kritis saat set_trading_stop fallback: %s", exc)

    async def _ensure_leverage(self, symbol: str, is_long: bool) -> None:
        try:
            exchange_id = self._exchange.id
            if exchange_id == "bybit":
                await self._exchange.set_leverage(
                    self._leverage, symbol,
                    params={"positionIdx": 0},
                )
            elif exchange_id == "mexc":
                pos_type = 1 if is_long else 2
                await self._exchange.set_leverage(
                    self._leverage, symbol,
                    params={"marginMode": "isolated", "openType": 1, "positionType": pos_type},
                )
            else:
                await self._exchange.set_leverage(self._leverage, symbol)
                
            logger.info("[Executor] Leverage set: %dx on %s", self._leverage, symbol)
        except ExchangeError as exc:
            logger.warning("[Executor] set_leverage warning (non-fatal): %s", exc)
        except Exception as exc:
            logger.warning("[Executor] set_leverage unexpected error (non-fatal): %s", exc)

    async def _place_order(
        self,
        label:      str,
        order_type: str,
        side:       str,
        symbol:     str,
        amount:     float,
        price:      Optional[float],
        params:     dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                order = await self._exchange.create_order(
                    symbol = symbol,
                    type   = order_type,
                    side   = side,
                    amount = amount,
                    price  = price,
                    params = params,
                )
                return order

            except InsufficientFunds as exc:
                logger.error("[Executor][%s] InsufficientFunds: %s", label, exc)
                return None

            except RateLimitExceeded as exc:
                delay = _RETRY_BASE_DELAY * (2 ** (attempt - 1))
                logger.warning(
                    "[Executor][%s] RateLimitExceeded (attempt %d/%d) — retry in %.1fs | %s",
                    label, attempt, _MAX_RETRIES, delay, exc,
                )
                if attempt < _MAX_RETRIES:
                    await asyncio.sleep(delay)

            except NetworkError as exc:
                delay = _RETRY_BASE_DELAY * (2 ** (attempt - 1))
                logger.warning(
                    "[Executor][%s] NetworkError (attempt %d/%d) — retry in %.1fs | %s",
                    label, attempt, _MAX_RETRIES, delay, exc,
                )
                if attempt < _MAX_RETRIES:
                    await asyncio.sleep(delay)

            except ExchangeError as exc:
                logger.error("[Executor][%s] ExchangeError (fatal): %s", label, exc)
                return None

            except Exception as exc:
                logger.exception("[Executor][%s] Unexpected error: %s", label, exc)
                return None

        logger.error("[Executor][%s] All %d retries exhausted.", label, _MAX_RETRIES)
        return None


    async def _naked_position_guard(
        self,
        symbol:         str,
        entry_order_id: str,
        position_size:  float,
        exit_side:      str,
    ) -> None:
        logger.warning(
            "[NakedPositionGuard] Cancelling entry id=%s on %s", entry_order_id, symbol
        )
        try:
            await self._exchange.cancel_order(entry_order_id, symbol)
            logger.info("[NakedPositionGuard] Entry order cancelled.")
        except ExchangeError as exc:
            logger.warning("[NakedPositionGuard] Cancel returned error (may be filled): %s", exc)
        except Exception as exc:
            logger.exception("[NakedPositionGuard] Unexpected cancel error: %s", exc)

        try:
            positions  = await self._exchange.fetch_positions([symbol])
            open_pos   = [
                p for p in positions
                if p.get("symbol") == symbol
                and abs(float(p.get("contracts") or 0)) > _PRICE_EPSILON
            ]

            if not open_pos:
                logger.info("[NakedPositionGuard] No open position confirmed — guard complete.")
                return

            exposed_size = sum(abs(float(p.get("contracts", 0))) for p in open_pos)
            logger.warning(
                "[NakedPositionGuard] Exposure found: %.6f contracts on %s. "
                "Submitting market-close (accepting slippage to cap risk).",
                exposed_size, symbol,
            )

            close_order = await self._exchange.create_order(
                symbol = symbol,
                type   = "market",
                side   = exit_side,
                amount = exposed_size,
                params = {"reduceOnly": True},
            )
            logger.info(
                "[NakedPositionGuard] Market-close submitted | id=%s",
                close_order.get("id", "unknown"),
            )

        except Exception as exc:
            logger.critical(
                "[NakedPositionGuard] CRITICAL — NAKED POSITION on %s. "
                "Automated close failed. MANUAL INTERVENTION REQUIRED. Error: %s",
                symbol, exc,
            )


    async def _fetch_free_usdt(self) -> float:
        balance: dict = await self._exchange.fetch_balance()

        usdt = float((balance.get("free") or {}).get("USDT", 0.0))
        if usdt > 0:
            logger.debug("[Executor] balance via ccxt[free][USDT]=%.2f", usdt)
            return usdt

        usdt_entry = balance.get("USDT")
        if isinstance(usdt_entry, dict):
            usdt = float(usdt_entry.get("free", 0.0))
            if usdt > 0:
                logger.debug("[Executor] balance via ccxt[USDT][free]=%.2f", usdt)
                return usdt

        raw_list: list = (
            (balance.get("info") or {})
            .get("result", {})
            .get("list", [])
        )
        for account in raw_list:
            for coin in (account.get("coin") or []):
                if not isinstance(coin, dict):
                    continue
                if coin.get("coin") != "USDT":
                    continue
                raw_val = (
                    coin.get("availableToWithdraw")
                    or coin.get("availableToBorrow")
                    or coin.get("walletBalance")
                    or "0"
                )
                usdt = float(raw_val or 0)
                if usdt > 0:
                    logger.debug(
                        "[Executor] balance via raw info (accountType=%s) USDT=%.2f",
                        account.get("accountType", "?"), usdt,
                    )
                    return usdt

        logger.debug(
            "[Executor] fetch_balance miss — top-level keys=%s | free=%s | "
            "raw_accounts=%d",
            list(balance.keys()),
            balance.get("free"),
            len(raw_list),
        )
        return 0.0

    def _calculate_position_size(
        self,
        balance:   float,
        entry:     float,
        stop_loss: float,
    ) -> Optional[float]:
        stop_distance = abs(entry - stop_loss)
        if stop_distance < _PRICE_EPSILON:
            logger.error(
                "[Executor] Degenerate signal: stop_distance=%.2e (entry=%.4f sl=%.4f)",
                stop_distance, entry, stop_loss,
            )
            return None

        risk_amount = balance * self._risk_pct
        return risk_amount / stop_distance

    def _apply_exchange_precision(
        self,
        symbol:   str,
        raw_size: float,
    ) -> Optional[float]:
        try:
            rounded = float(self._exchange.amount_to_precision(symbol, raw_size))
        except Exception as exc:
            logger.warning(
                "[Executor] amount_to_precision failed (%s) — using raw size %.6f",
                exc, raw_size,
            )
            rounded = raw_size

        if rounded <= 0:
            return None
        return rounded