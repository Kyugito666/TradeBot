"""
converter.py – Background daemon that converts Rust Brain binary database files
into Apache Parquet and ORC columnar formats.

Binary formats are defined in the Rust `db.rs` module.  This module reads the
raw .bin files produced by the trading engine, parses them record-by-record
using `struct`, and writes the results via PyArrow to both Parquet and ORC.

Usage
-----
    # One-shot conversion
    from converter import run_conversion
    run_conversion()

    # Daemon mode (blocks current thread, converts every 5 min)
    from converter import start_daemon
    start_daemon(interval_seconds=300)
"""

from __future__ import annotations

import logging
import os
import struct
import threading
import time
from dataclasses import dataclass, fields
from pathlib import Path
from typing import Any, BinaryIO, Callable, Dict, List, Optional, Sequence, Type

import pyarrow as pa
import pyarrow.orc as orc
import pyarrow.parquet as pq

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

DB_BASE_PATH = os.environ.get("BOT_DB_PATH", "/mnt/d/database")

SRC_DIR = os.path.join(DB_BASE_PATH, "engine")
PARQUET_DIR = os.path.join(DB_BASE_PATH, "parquet", "history")
ORC_DIR = os.path.join(DB_BASE_PATH, "orc", "history")

logger = logging.getLogger("converter")
logger.setLevel(logging.DEBUG)

if not logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(
        logging.Formatter(
            "%(asctime)s | %(name)s | %(levelname)-7s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logger.addHandler(_handler)


# ---------------------------------------------------------------------------
# Dataclass schemas – one per record type
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class TradeRecord:
    """Schema for trade / paper / shadow records."""

    open_ts: int
    close_ts: int
    symbol: str
    direction: str
    entry: float
    tp: float
    sl: float
    close_price: float
    is_win: bool
    rr: float


@dataclass(slots=True)
class BacktestRecord:
    """Schema for backtest result records."""

    ts: int
    cex: str
    timeframe: str
    period_days: int
    profit_factor: float
    net_pnl: float
    trades: int
    win_rate: float
    scanned: int


# ---------------------------------------------------------------------------
# Binary parsing helpers
# ---------------------------------------------------------------------------


def _read_exact(f: BinaryIO, n: int) -> bytes:
    """Read exactly *n* bytes or raise ``EOFError``."""
    data = f.read(n)
    if len(data) != n:
        raise EOFError(f"Expected {n} bytes, got {len(data)}")
    return data


def _read_length_prefixed_string(f: BinaryIO) -> str:
    """Read a 1-byte-length-prefixed UTF-8 string."""
    (length,) = struct.unpack(">B", _read_exact(f, 1))
    return _read_exact(f, length).decode("utf-8")


def _parse_trade_record(f: BinaryIO) -> TradeRecord:
    """Parse a single trade/paper/shadow record from the stream."""
    open_ts, close_ts = struct.unpack(">qq", _read_exact(f, 16))
    symbol = _read_length_prefixed_string(f)
    direction = _read_length_prefixed_string(f)
    entry, tp, sl, close_price = struct.unpack(">dddd", _read_exact(f, 32))
    (is_win_byte,) = struct.unpack(">B", _read_exact(f, 1))
    (rr,) = struct.unpack(">d", _read_exact(f, 8))
    return TradeRecord(
        open_ts=open_ts,
        close_ts=close_ts,
        symbol=symbol,
        direction=direction,
        entry=entry,
        tp=tp,
        sl=sl,
        close_price=close_price,
        is_win=is_win_byte == 1,
        rr=rr,
    )


def _parse_backtest_record(f: BinaryIO) -> BacktestRecord:
    """Parse a single backtest record from the stream."""
    (ts,) = struct.unpack(">q", _read_exact(f, 8))
    cex = _read_length_prefixed_string(f)
    timeframe = _read_length_prefixed_string(f)
    (period_days,) = struct.unpack(">i", _read_exact(f, 4))
    (profit_factor,) = struct.unpack(">d", _read_exact(f, 8))
    (net_pnl,) = struct.unpack(">d", _read_exact(f, 8))
    (trades,) = struct.unpack(">i", _read_exact(f, 4))
    (win_rate,) = struct.unpack(">d", _read_exact(f, 8))
    (scanned,) = struct.unpack(">i", _read_exact(f, 4))
    return BacktestRecord(
        ts=ts,
        cex=cex,
        timeframe=timeframe,
        period_days=period_days,
        profit_factor=profit_factor,
        net_pnl=net_pnl,
        trades=trades,
        win_rate=win_rate,
        scanned=scanned,
    )


def _parse_all_records(
    path: str,
    parser: Callable[[BinaryIO], Any],
    label: str,
) -> List[Any]:
    """Open *path* and parse all records using *parser*, skipping corrupt tails."""
    if not os.path.isfile(path):
        logger.warning("File not found, skipping: %s", path)
        return []

    file_size = os.path.getsize(path)
    if file_size == 0:
        logger.info("Empty file, skipping: %s", path)
        return []

    records: List[Any] = []
    with open(path, "rb") as f:
        while True:
            pos = f.tell()
            try:
                record = parser(f)
                records.append(record)
            except EOFError:
                # Reached end-of-file (possibly mid-record → partial/corrupt)
                remaining = file_size - pos
                if remaining > 0:
                    logger.warning(
                        "%s: skipped %d trailing bytes (partial record) at offset %d",
                        label,
                        remaining,
                        pos,
                    )
                break
            except Exception as exc:
                logger.error(
                    "%s: corrupt record at offset %d – %s. Stopping parse.",
                    label,
                    pos,
                    exc,
                )
                break

    logger.info("%s: parsed %d records from %s", label, len(records), path)
    return records


# ---------------------------------------------------------------------------
# PyArrow schema builders
# ---------------------------------------------------------------------------

TRADE_ARROW_SCHEMA = pa.schema(
    [
        pa.field("open_ts", pa.int64()),
        pa.field("close_ts", pa.int64()),
        pa.field("symbol", pa.string()),
        pa.field("direction", pa.string()),
        pa.field("entry", pa.float64()),
        pa.field("tp", pa.float64()),
        pa.field("sl", pa.float64()),
        pa.field("close_price", pa.float64()),
        pa.field("is_win", pa.bool_()),
        pa.field("rr", pa.float64()),
    ]
)

BACKTEST_ARROW_SCHEMA = pa.schema(
    [
        pa.field("ts", pa.int64()),
        pa.field("cex", pa.string()),
        pa.field("timeframe", pa.string()),
        pa.field("period_days", pa.int32()),
        pa.field("profit_factor", pa.float64()),
        pa.field("net_pnl", pa.float64()),
        pa.field("trades", pa.int32()),
        pa.field("win_rate", pa.float64()),
        pa.field("scanned", pa.int32()),
    ]
)


def _records_to_table(
    records: Sequence[Any],
    schema: pa.Schema,
) -> pa.Table:
    """Convert a list of dataclass instances to a ``pyarrow.Table``."""
    if not records:
        return pa.table({field.name: pa.array([], type=field.type) for field in schema}, schema=schema)

    columns: Dict[str, list] = {field.name: [] for field in schema}
    for rec in records:
        for field in schema:
            columns[field.name].append(getattr(rec, field.name))

    arrays = [pa.array(columns[field.name], type=field.type) for field in schema]
    return pa.table(arrays, schema=schema)


# ---------------------------------------------------------------------------
# Writers
# ---------------------------------------------------------------------------


def _write_parquet(table: pa.Table, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    pq.write_table(table, dest, compression="snappy")
    logger.info("Wrote Parquet: %s (%d rows)", dest, table.num_rows)


def _write_orc(table: pa.Table, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    orc.write_table(table, dest)
    logger.info("Wrote ORC:     %s (%d rows)", dest, table.num_rows)


# ---------------------------------------------------------------------------
# Conversion jobs
# ---------------------------------------------------------------------------

# Mapping: (source_bin, parser, arrow_schema, parquet_name, orc_name, label)
_TRADE_JOBS = [
    ("paper_records.bin", "paper_trades", "Paper trades"),
    ("shadow_records.bin", "shadow_trades", "Shadow trades"),
    ("trade_records.bin", "trade_history", "Trade history"),
]

_BACKTEST_JOB = ("backtest_records.bin", "backtest_results", "Backtest results")


def run_conversion() -> None:
    """Run a single conversion pass over all known binary database files."""
    logger.info("=== Conversion pass started ===")
    start = time.monotonic()

    # ---- Trade-type records (paper / shadow / live) ----
    for src_name, out_stem, label in _TRADE_JOBS:
        src_path = os.path.join(SRC_DIR, src_name)
        records = _parse_all_records(src_path, _parse_trade_record, label)
        table = _records_to_table(records, TRADE_ARROW_SCHEMA)

        if table.num_rows == 0:
            logger.info("%s: 0 records – skipping output.", label)
            continue

        _write_parquet(table, os.path.join(PARQUET_DIR, f"{out_stem}.parquet"))
        _write_orc(table, os.path.join(ORC_DIR, f"{out_stem}.orc"))

    # ---- Backtest records ----
    src_path = os.path.join(SRC_DIR, _BACKTEST_JOB[0])
    records = _parse_all_records(src_path, _parse_backtest_record, _BACKTEST_JOB[2])
    table = _records_to_table(records, BACKTEST_ARROW_SCHEMA)

    if table.num_rows > 0:
        _write_parquet(table, os.path.join(PARQUET_DIR, f"{_BACKTEST_JOB[1]}.parquet"))
        _write_orc(table, os.path.join(ORC_DIR, f"{_BACKTEST_JOB[1]}.orc"))
    else:
        logger.info("%s: 0 records – skipping output.", _BACKTEST_JOB[2])

    elapsed = time.monotonic() - start
    logger.info("=== Conversion pass finished in %.2f s ===", elapsed)


# ---------------------------------------------------------------------------
# Daemon mode
# ---------------------------------------------------------------------------

_daemon_stop_event = threading.Event()


def start_daemon(interval_seconds: int = 300) -> threading.Thread:
    """Start the converter as a background daemon thread.

    Parameters
    ----------
    interval_seconds:
        Seconds to sleep between conversion passes (default 300 = 5 min).

    Returns
    -------
    threading.Thread
        The daemon thread (already started).  Call ``stop_daemon()`` to
        request a graceful shutdown.
    """

    def _loop() -> None:
        logger.info(
            "Converter daemon started (interval=%d s). "
            "Call stop_daemon() to shut down.",
            interval_seconds,
        )
        while not _daemon_stop_event.is_set():
            try:
                run_conversion()
            except Exception:
                logger.exception("Unhandled error during conversion pass")
            _daemon_stop_event.wait(timeout=interval_seconds)
        logger.info("Converter daemon stopped.")

    _daemon_stop_event.clear()
    t = threading.Thread(target=_loop, name="converter-daemon", daemon=True)
    t.start()
    return t


def stop_daemon() -> None:
    """Signal the daemon thread to stop after the current sleep/pass."""
    _daemon_stop_event.set()
    logger.info("Converter daemon stop requested.")


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Convert Rust Brain binary DB files to Parquet & ORC.",
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="Run as a repeating daemon instead of a one-shot conversion.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=300,
        help="Seconds between conversion passes in daemon mode (default: 300).",
    )
    args = parser.parse_args()

    if args.daemon:
        thread = start_daemon(interval_seconds=args.interval)
        try:
            while thread.is_alive():
                thread.join(timeout=1.0)
        except KeyboardInterrupt:
            logger.info("KeyboardInterrupt received – shutting down.")
            stop_daemon()
            thread.join(timeout=10)
    else:
        run_conversion()
