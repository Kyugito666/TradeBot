"""
Bot Web Dashboard Server
========================
Jalankan: python bot_server.py
Buka:     http://localhost:8765
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import subprocess
import sys
import threading
import sqlite3
import socket
import time
import urllib.request
import hmac
import hashlib
from urllib.error import URLError, HTTPError
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

# ── Log interceptor ──────────────────────────────────────────────────────────

log_buffer: list[dict] = []
log_lock = threading.Lock()
_MAX_LOGS = 500

class WebLogHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        entry = {
            "ts":    self.formatTime(record, "%H:%M:%S"),
            "level": record.levelname,
            "name":  record.name.split(".")[-1],
            "msg":   record.getMessage(),
        }
        with log_lock:
            log_buffer.append(entry)
            if len(log_buffer) > _MAX_LOGS:
                log_buffer.pop(0)

_web_handler = WebLogHandler()
_web_handler.setLevel(logging.DEBUG)
logging.getLogger().addHandler(_web_handler)

# ── Bot process manager ───────────────────────────────────────────────────────

class BotProcess:
    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()
        self._reader_thread: Optional[threading.Thread] = None

    @property
    def running(self) -> bool:
        with self._lock:
            return self._proc is not None and self._proc.poll() is None

    def start(self, env_override: dict) -> tuple[bool, str]:
        with self._lock:
            if self._proc and self._proc.poll() is None:
                return False, "Bot sudah running."

            env = os.environ.copy()
            env.update(env_override)

            try:
                self._proc = subprocess.Popen(
                    [sys.executable, "main.py"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    env=env,
                )
                self._reader_thread = threading.Thread(
                    target=self._read_output,
                    args=(self._proc,),
                    daemon=True,
                )
                self._reader_thread.start()
                return True, f"Bot started (PID {self._proc.pid})"
            except Exception as exc:
                return False, f"Gagal start: {exc}"

    def stop(self) -> tuple[bool, str]:
        with self._lock:
            if not self._proc or self._proc.poll() is not None:
                return False, "Bot tidak sedang running."
            try:
                self._proc.terminate()
                return True, "Stop signal dikirim."
            except Exception as exc:
                return False, f"Gagal stop: {exc}"

    def _read_output(self, proc: subprocess.Popen) -> None:
        _LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue

            parts = line.split("|", 3)
            ts    = datetime.now().strftime("%H:%M:%S")
            level = "INFO"
            name  = "bot"
            msg   = line

            if len(parts) >= 4:
                raw_ts  = parts[0].strip()
                raw_lvl = parts[1].strip()
                raw_nam = parts[2].strip().split(".")[-1]
                raw_msg = parts[3].strip()
                if raw_lvl in _LEVELS:
                    ts    = raw_ts
                    level = raw_lvl
                    name  = raw_nam
                    msg   = raw_msg
            elif len(parts) == 3:
                raw_lvl = parts[1].strip()
                if raw_lvl in _LEVELS:
                    ts    = parts[0].strip()
                    level = raw_lvl
                    msg   = parts[2].strip()

            entry = {
                "ts":    ts,
                "level": level,
                "name":  name,
                "msg":   msg,
            }
            with log_lock:
                log_buffer.append(entry)
                if len(log_buffer) > _MAX_LOGS:
                    log_buffer.pop(0)

bot = BotProcess()

# ── Dotenv reader/writer ──────────────────────────────────────────────────────

ENV_FILE = Path(".env")

def read_env() -> dict[str, str]:
    result = {}
    if not ENV_FILE.exists():
        return result
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        result[k.strip()] = v.strip().strip('"').strip("'")
    return result

def write_env(data: dict[str, str]) -> None:
    lines = []
    existing_keys = set()
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                k = stripped.partition("=")[0].strip()
                if k in data:
                    lines.append(f"{k}={data[k]}")
                    existing_keys.add(k)
                    continue
            lines.append(line)
    for k, v in data.items():
        if k not in existing_keys:
            lines.append(f"{k}={v}")
    ENV_FILE.write_text("\n".join(lines) + "\n")

# ── AI Insight Background Fetcher (Adaptive Risk Engine) ─────────────────────

def safe_float(val, default=0.0):
    try:
        return float(val) if val else default
    except:
        return default

class InsightBackgroundFetcher(threading.Thread):
    def __init__(self, bot_ref: BotProcess) -> None:
        super().__init__(daemon=True)
        self.bot = bot_ref
        self.insight_file = Path("bot_insight.json")
        self.interval = 10
        self.logger = logging.getLogger("InsightFetcher")

    def _fetch_json(self, url: str) -> dict:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req, timeout=5) as response:
            return json.loads(response.read().decode())

    def run(self) -> None:
        self.logger.info("Background Adaptive AI Fetcher started.")
        while True:
            time.sleep(self.interval)
            
            env_vars = read_env()
            symbol = env_vars.get("SYMBOL", "BTCUSDT").replace("/", "").replace(":", "").replace("-", "")
            exchange = env_vars.get("EXCHANGE", "bybit")
            trading_style = env_vars.get("TRADING_STYLE", "daytrade")
            is_demo = env_vars.get("EXCHANGE_MODE", "demo") == "demo"
            
            api_key = env_vars.get("BYBIT_DEMO_API_KEY", "") if is_demo else env_vars.get("BYBIT_REAL_API_KEY", "")
            api_sec = env_vars.get("BYBIT_DEMO_API_SECRET", "") if is_demo else env_vars.get("BYBIT_REAL_API_SECRET", "")

            # Adaptasi Matrix berdasarkan Style
            # tf = Timeframe kline, sl_mult = Jarak SL dari ATR, tp_mult = Jarak TP
            if trading_style == "scalping":
                tf = "5"
                sl_mult = 1.0  # SL ketat
                tp_mult = 1.5  # Quick in & out
            elif trading_style == "sniper":
                tf = "60"      # 1 Jam
                sl_mult = 2.0  # SL lega, nahan ayunan
                tp_mult = 4.0  # Ngincer swing gajah
            else: # daytrade
                tf = "15"
                sl_mult = 1.5
                tp_mult = 2.5

            try:
                # 1. Fetch Ticker
                url_ticker = f"https://api.bybit.com/v5/market/tickers?category=linear&symbol={symbol}"
                ticker_data = self._fetch_json(url_ticker)
                t_list = ticker_data.get("result", {}).get("list", [{}])
                if not t_list: t_list = [{}]
                
                last_price = safe_float(t_list[0].get("lastPrice"))
                pct_24h = safe_float(t_list[0].get("price24hPcnt")) * 100
                oi_val = safe_float(t_list[0].get("openInterest"))
                
                # 2. Fetch Klines (Timeframe ngikutin Style)
                url_kline = f"https://api.bybit.com/v5/market/kline?category=linear&symbol={symbol}&interval={tf}&limit=14"
                kline_data = self._fetch_json(url_kline)
                klines = kline_data.get("result", {}).get("list", [])
                
                atr = last_price * 0.01 if last_price > 0 else 0.01
                if klines:
                    tr_list = []
                    for i in range(len(klines)-1):
                        h, l, pc = safe_float(klines[i][2]), safe_float(klines[i][3]), safe_float(klines[i+1][4])
                        tr_list.append(max(h - l, abs(h - pc), abs(l - pc)))
                    if tr_list: atr = sum(tr_list) / len(tr_list)
                
                # 3. Fetch LSR
                url_lsr = f"https://api.bybit.com/v5/market/account-ratio?category=linear&symbol={symbol}&period=5min&limit=1"
                lsr_data = self._fetch_json(url_lsr)
                list_lsr = lsr_data.get("result", {}).get("list", [])
                
                lsr_val = 1.0
                if list_lsr:
                    buy = safe_float(list_lsr[0].get("buyRatio"))
                    sell = safe_float(list_lsr[0].get("sellRatio"))
                    lsr_val = buy / (sell if sell > 0 else 1.0)

                # 4. Fetch Balance
                balance_val = 0.0
                if api_key and api_sec and exchange == "bybit":
                    try:
                        ts_msec = str(int(time.time() * 1000))
                        query = "accountType=UNIFIED&coin=USDT"
                        param_str = ts_msec + api_key + "5000" + query
                        signature = hmac.new(bytes(api_sec, "utf-8"), param_str.encode("utf-8"), hashlib.sha256).hexdigest()
                        
                        base_url = "https://api-testnet.bybit.com" if is_demo else "https://api.bybit.com"
                        req_bal = urllib.request.Request(f"{base_url}/v5/account/wallet-balance?{query}", headers={
                            'X-BAPI-API-KEY': api_key, 'X-BAPI-TIMESTAMP': ts_msec,
                            'X-BAPI-SIGN': signature, 'X-BAPI-RECV-WINDOW': "5000"
                        })
                        with urllib.request.urlopen(req_bal, timeout=3) as res:
                            bal_data = json.loads(res.read().decode())
                            list_acc = bal_data.get("result", {}).get("list", [])
                            if list_acc:
                                for c in list_acc[0].get("coin", []):
                                    if c["coin"] == "USDT": balance_val = safe_float(c["walletBalance"])
                    except Exception:
                        pass 

                # 5. Adaptive Strategy Logic
                entry = last_price
                action = "WAIT"
                
                # Cek volatility regime untuk melebarkan SL jika badai
                current_vol_risk = (atr / last_price) * 100
                if current_vol_risk > 3.0: # Market super volatile (kayak anomali SOL kemaren)
                    sl_mult *= 1.5 # Lebarkan SL biar ga gampang kesapu ekor / wick
                
                if lsr_val > 1.08:
                    action = "SHORT"
                    whale_bias = "SHORT_HUNTING"
                    trend = "BEARISH_TRAP"
                    sl, tp = entry + (atr * sl_mult), entry - (atr * tp_mult)
                    advice = f"[{trading_style.upper()}] LSR Retail tinggi ({lsr_val:.2f}). Awas liquidity sweep ke bawah. Target: SL {sl_mult}x ATR, TP {tp_mult}x ATR. Menunggu Setup!"
                elif lsr_val < 0.92 and lsr_val > 0.0:
                    action = "LONG"
                    whale_bias = "LONG_HUNTING"
                    trend = "BULLISH_TRAP"
                    sl, tp = entry - (atr * sl_mult), entry + (atr * tp_mult)
                    advice = f"[{trading_style.upper()}] Retail dominan SHORT ({lsr_val:.2f}). Potensi short-squeeze. Target: SL {sl_mult}x ATR, TP {tp_mult}x ATR. Cari rejection support."
                else:
                    whale_bias = "NEUTRAL_ACCUMULATION"
                    trend = "RANGING / CHOPPY"
                    sl, tp = 0.0, 0.0
                    advice = f"[{trading_style.upper()}] Pasar sideway/choppy (LSR {lsr_val:.2f}). ATR kompresi: {atr:.2f}. Style ini merekomendasikan WAIT."

                bot_status_str = " (BOT ACTIVE)" if self.bot.running else " (STANDBY)"

                insight_data = {
                    "timestamp": datetime.now().strftime("%H:%M:%S"),
                    "trend_state": trend, "whale_bias": whale_bias, "advice": advice,
                    "signal_status": action + bot_status_str,
                    "last_price": last_price, "pct_24h": pct_24h, "open_interest": oi_val, "lsr_val": lsr_val,
                    "balance": balance_val,
                    "entry_target": round(entry, 4) if action != "WAIT" else 0,
                    "tp_target": round(tp, 4) if action != "WAIT" else 0,
                    "sl_target": round(sl, 4) if action != "WAIT" else 0
                }

                self.insight_file.write_text(json.dumps(insight_data, indent=2))
                
            except Exception as e:
                self.logger.debug(f"Insight Fetch gagal: {e}")

# ── HTTP handler ──────────────────────────────────────────────────────────────

class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, data: dict, status: int = 200) -> None:
        try:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except:
            pass

    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return

        if parsed.path == "/" or parsed.path == "/index.html":
            html_file = Path(__file__).parent / "dashboard.html"
            try:
                body = html_file.read_bytes()
            except FileNotFoundError:
                body = b"<h1>Error: dashboard.html tidak ditemukan</h1>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/api/logs":
            qs    = parse_qs(parsed.query)
            since = int(qs.get("since", ["0"])[0])
            with log_lock:
                new_logs = log_buffer[since:]
                total    = len(log_buffer)
            self._json({"logs": new_logs, "total": total, "running": bot.running})
            return

        if parsed.path == "/api/get-env":
            self._json({"env": read_env()})
            return

        if parsed.path == "/api/trades":
            self._json({"ok": True, "trades": []})
            return

        if parsed.path == "/api/insight":
            try:
                insight_path = Path("bot_insight.json")
                if insight_path.exists():
                    body = insight_path.read_bytes()
                else:
                    body = json.dumps({
                        "timestamp": "-", "trend_state": "WAITING", "whale_bias": "-", "advice": "Menunggu siklus analisis...",
                        "signal_status": "-", "entry_target": 0, "tp_target": 0, "sl_target": 0
                    }).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return

        self.send_error(404)

    def do_POST(self) -> None:
        length   = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length)
        try:
            body = json.loads(raw_body) if raw_body else {}
        except Exception:
            body = {}

        if self.path == "/api/start":
            ok, msg = bot.start(body)
            self._json({"ok": ok, "message": msg})
            return

        if self.path == "/api/stop":
            ok, msg = bot.stop()
            self._json({"ok": ok, "message": msg})
            return

        if self.path == "/api/save-env":
            try:
                to_save = {k: v for k, v in body.items() if v}
                write_env(to_save)
                self._json({"ok": True, "message": "Config tersimpan ke .env ✓"})
            except Exception as exc:
                self._json({"ok": False, "message": f"Gagal simpan: {exc}"})
            return

        if self.path == "/api/clear-logs":
            with log_lock:
                log_buffer.clear()
            self._json({"ok": True})
            return

        self.send_error(404)

def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except:
        return "127.0.0.1"

if __name__ == "__main__":
    HOST, PORT = "0.0.0.0", 8765
    local_ip = get_local_ip()
    
    insight_fetcher = InsightBackgroundFetcher(bot)
    insight_fetcher.start()

    server = HTTPServer((HOST, PORT), DashboardHandler)
    print(f"\n  ⬡  BotTrade Dashboard")
    print(f"  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"  Buka di PC : http://localhost:{PORT}")
    print(f"  Buka di HP : http://{local_ip}:{PORT}")
    print(f"  Ctrl+C untuk keluar\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        if bot.running:
            bot.stop()
        print("\n  Dashboard stopped.")