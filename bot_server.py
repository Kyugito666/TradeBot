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
import subprocess
import sys
import threading
import socket
import time
import urllib.request
import aiohttp
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse
from aiohttp.abc import AbstractResolver

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

# ── DNS Bypass Resolver ───────────────────────────────────────────────────────

class BypassNawalaResolver(AbstractResolver):
    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list:
        try:
            socket.inet_aton(host)
            return [{"hostname": host, "host": host, "port": port, "family": family, "proto": 0, "flags": 0}]
        except socket.error:
            pass
            
        try:
            url = f"https://cloudflare-dns.com/dns-query?name={host}&type=A"
            req = urllib.request.Request(url, headers={"Accept": "application/dns-json"})
            def fetch_ip():
                with urllib.request.urlopen(req, timeout=5) as response:
                    return json.loads(response.read().decode())
            data = await asyncio.to_thread(fetch_ip)
            for answer in data.get("Answer", []):
                if answer.get("type") == 1:
                    real_ip = answer["data"]
                    return [{"hostname": host, "host": real_ip, "port": port, "family": family, "proto": 0, "flags": 0}]
        except Exception:
            pass
        return [{"hostname": host, "host": host, "port": port, "family": family, "proto": 0, "flags": 0}]
        
    async def close(self) -> None:
        pass

# ── Bot process manager ───────────────────────────────────────────────────────

class BotProcess:
    def __init__(self) -> None:
        self._proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

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
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, bufsize=1, env=env,
                )
                threading.Thread(target=self._read_output, args=(self._proc,), daemon=True).start()
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
        for line in proc.stdout:
            line = line.rstrip()
            if not line: continue
            parts = line.split("|", 3)
            if len(parts) >= 4:
                ts, level, name, msg = [p.strip() for p in parts]
            else:
                ts, level, name, msg = datetime.now().strftime("%H:%M:%S"), "INFO", "bot", line

            with log_lock:
                log_buffer.append({"ts": ts, "level": level, "name": name, "msg": msg})
                if len(log_buffer) > _MAX_LOGS: log_buffer.pop(0)

bot = BotProcess()

# ── Dotenv reader/writer ──────────────────────────────────────────────────────

ENV_FILE = Path(".env")

def read_env() -> dict[str, str]:
    res = {}
    if not ENV_FILE.exists(): return res
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line: continue
        k, _, v = line.partition("=")
        res[k.strip()] = v.strip().strip('"').strip("'")
    return res

def write_env(data: dict[str, str]) -> None:
    lines = []
    keys = set()
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            s = line.strip()
            if s and not s.startswith("#") and "=" in s:
                k = s.partition("=")[0].strip()
                if k in data:
                    lines.append(f"{k}={data[k]}")
                    keys.add(k)
                    continue
            lines.append(line)
    for k, v in data.items():
        if k not in keys: lines.append(f"{k}={v}")
    ENV_FILE.write_text("\n".join(lines) + "\n")

def safe_float(val, default=0.0):
    try: return float(val) if val else default
    except: return default

# ── AI Insight Background Fetcher (Micro-Polling Fix) ─────────────────────────

class InsightBackgroundFetcher(threading.Thread):
    def __init__(self, bot_ref: BotProcess) -> None:
        super().__init__(daemon=True)
        self.bot = bot_ref
        self.insight_file = Path("bot_insight.json")
        self.interval = 5 
        self.logger = logging.getLogger("InsightFetcher")
        
        self.current_symbol = ""
        self.locked_action = "WAIT"
        self.locked_entry = 0.0
        self.locked_tp = 0.0
        self.locked_sl = 0.0
        self.locked_advice = "Menganalisa Struktur Market..."
        self.flip_counter = 0
        self.tick_counter = 0

    def run(self) -> None:
        if sys.platform == 'win32':
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        asyncio.run(self.async_run())

    async def async_run(self) -> None:
        stealth_resolver = BypassNawalaResolver()
        connector = aiohttp.TCPConnector(resolver=stealth_resolver, keepalive_timeout=60)
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36",
            "Accept": "application/json"
        }
        
        async with aiohttp.ClientSession(connector=connector, headers=headers) as session:
            while True:
                # FIX: Micro-polling agar saat ganti koin, responsif < 1 detik!
                await asyncio.sleep(1)
                
                env_vars = read_env()
                raw_symbol = env_vars.get("SYMBOL", "BTCUSDT")
                exchange = env_vars.get("EXCHANGE", "bybit").lower()
                style = env_vars.get("TRADING_STYLE", "daytrade")
                
                symbol_mexc = f"{raw_symbol[:-4]}_{raw_symbol[-4:]}" if "_" not in raw_symbol and raw_symbol.endswith("USDT") else raw_symbol
                symbol_bybit = raw_symbol.replace("_", "")
                
                active_symbol = symbol_mexc if exchange == "mexc" else symbol_bybit
                
                force_fetch = False
                if active_symbol != self.current_symbol:
                    self.current_symbol = active_symbol
                    self.locked_action = "WAIT"
                    self.flip_counter = 0
                    self.locked_entry, self.locked_tp, self.locked_sl = 0.0, 0.0, 0.0
                    self.locked_advice = f"🔄 Radar AI dikalibrasi ke {exchange.upper()} ({active_symbol})..."
                    force_fetch = True  # Langsung tembak API tanpa tunggu interval 5 detik!
                    self.tick_counter = 0
                else:
                    self.tick_counter += 1
                    if self.tick_counter < self.interval:
                        continue # Skip fetch ke exchange
                    self.tick_counter = 0
                
                insight_data = {
                    "timestamp": datetime.now().strftime("%H:%M:%S"),
                    "trend_state": "WAITING", "whale_bias": "NEUTRAL",
                    "advice": self.locked_advice,
                    "signal_status": self.locked_action, 
                    "last_price": 0, "pct_24h": 0, 
                    "open_interest": 0, "lsr_val": 1.0, "balance": 0,
                    "entry_target": self.locked_entry, 
                    "tp_target": self.locked_tp, 
                    "sl_target": self.locked_sl
                }

                try:
                    tf = "5" if style == "scalping" else "60" if style == "sniper" else "15"
                    last_price = 0.0
                    pct_24h = 0.0
                    atr = 0.0
                    lsr_val = 1.0

                    if exchange == "mexc":
                        async with session.get(f"https://contract.mexc.com/api/v1/contract/ticker?symbol={active_symbol}") as res:
                            t_data = await res.json()
                            if t_data.get("success"):
                                last_price = float(t_data["data"].get("lastPrice", 0))
                                pct_24h = float(t_data["data"].get("riseFallRate", 0)) * 100

                        tf_mexc = "Min5" if style == "scalping" else "Min60" if style == "sniper" else "Min15"
                        async with session.get(f"https://contract.mexc.com/api/v1/contract/kline/{active_symbol}?interval={tf_mexc}") as res:
                            k_data = await res.json()
                            if k_data.get("success") and "data" in k_data:
                                highs = k_data["data"].get("high", [])[-15:]
                                lows = k_data["data"].get("low", [])[-15:]
                                closes = k_data["data"].get("close", [])[-16:-1]
                                if highs and lows and closes:
                                    tr_list = [max(float(h)-float(l), abs(float(h)-float(c)), abs(float(l)-float(c))) for h, l, c in zip(highs[1:], lows[1:], closes)]
                                    if tr_list: atr = sum(tr_list) / len(tr_list)
                    else:
                        async with session.get(f"https://api.bytick.com/v5/market/tickers?category=linear&symbol={active_symbol}") as res:
                            t_data = await res.json()
                            t_list = t_data.get("result", {}).get("list", [{}])
                            if t_list:
                                last_price = float(t_list[0].get("lastPrice", 0))
                                pct_24h = float(t_list[0].get("price24hPcnt", 0)) * 100
                                insight_data["open_interest"] = float(t_list[0].get("openInterest", 0))

                        async with session.get(f"https://api.bytick.com/v5/market/kline?category=linear&symbol={active_symbol}&interval={tf}&limit=14") as res:
                            k_data = await res.json()
                            klines = k_data.get("result", {}).get("list", [])
                            if klines:
                                tr_list = [max(float(k[2])-float(k[3]), abs(float(k[2])-float(k[4])), abs(float(k[3])-float(k[4]))) for k in klines[:-1]]
                                if tr_list: atr = sum(tr_list) / len(tr_list)
                        
                        async with session.get(f"https://api.bytick.com/v5/market/account-ratio?category=linear&symbol={active_symbol}&period=5min&limit=1") as res:
                            lsr_data = await res.json()
                            list_lsr = lsr_data.get("result", {}).get("list", [])
                            if list_lsr:
                                lsr_val = float(list_lsr[0].get("buyRatio", 1)) / (float(list_lsr[0].get("sellRatio", 1)) or 1.0)

                    if atr == 0 and last_price > 0: atr = last_price * 0.01

                    insight_data["pct_24h"] = pct_24h
                    insight_data["last_price"] = last_price
                    insight_data["lsr_val"] = lsr_val

                    volatility_pct = (atr / last_price) * 100 if last_price > 0 else 0
                    is_memecoin = (last_price < 1.0) or (volatility_pct > 1.5)
                    
                    if is_memecoin:
                        sl_mult = 2.5 if style == "scalping" else 4.0
                        tp_mult = 5.0 if style == "scalping" else 8.0
                        hysteresis_threshold = 4
                        mode_tag = "[MEME MODE] 🚀 "
                    else:
                        sl_mult = 1.5 if style == "scalping" else 2.5
                        tp_mult = 3.0 if style == "scalping" else 5.0
                        hysteresis_threshold = 3
                        mode_tag = ""

                    raw_action = "WAIT"
                    raw_advice = ""
                    
                    if lsr_val > 1.20 and pct_24h > 1.0:
                        raw_action = "LONG"
                        raw_advice = f"{mode_tag}SHORT SQUEEZE ALERT. Retail ngotot SHORT walau koin memompa. Bandar menargetkan likuidasi masal ke atas. BUY."
                    elif lsr_val > 1.15 and pct_24h <= 0.0:
                        raw_action = "SHORT"
                        raw_advice = f"{mode_tag}RETAIL TRAP. Mayoritas masuk LONG di pucuk. Bandar bersiap membanting harga. SELL."
                    elif lsr_val < 0.85 and pct_24h < -1.0:
                        raw_action = "SHORT"
                        raw_advice = f"{mode_tag}PANIC SELLING. Harga terjun, retail menangkap pisau jatuh. Tekanan bandar ke bawah. SELL."
                    elif lsr_val < 0.85 and pct_24h >= 0.0:
                        raw_action = "LONG"
                        raw_advice = f"{mode_tag}ACCUMULATION. Retail pesimis tapi support bertahan. Bandar menyerap suplai. Potensi Reversal. BUY."
                    else:
                        raw_action = "WAIT"
                        if force_fetch:
                            raw_advice = self.locked_advice
                        elif is_memecoin:
                            raw_advice = f"{mode_tag}Volatilitas sangat liar (ATR {volatility_pct:.1f}%). Belum ada konfirmasi bandar yang jelas. WAIT."
                        else:
                            raw_advice = f"Market stabil. Tunggu divergensi likuiditas untuk menemukan Edge."

                    if not force_fetch and raw_action != self.locked_action:
                        self.flip_counter += 1
                        if self.flip_counter >= hysteresis_threshold:
                            self.locked_action = raw_action
                            self.locked_advice = raw_advice
                            self.flip_counter = 0
                            
                            if raw_action != "WAIT":
                                self.locked_entry = last_price
                                if raw_action == "LONG":
                                    self.locked_sl = last_price - (atr * sl_mult)
                                    self.locked_tp = last_price + (atr * tp_mult)
                                else:
                                    self.locked_sl = last_price + (atr * sl_mult)
                                    self.locked_tp = last_price - (atr * tp_mult)
                            else:
                                self.locked_entry, self.locked_sl, self.locked_tp = 0.0, 0.0, 0.0
                    elif force_fetch:
                        self.flip_counter = 0 
                    else:
                        self.flip_counter = 0 
                    
                    insight_data["signal_status"] = self.locked_action
                    insight_data["advice"] = self.locked_advice
                    insight_data["entry_target"] = round(self.locked_entry, 6)
                    insight_data["tp_target"] = round(self.locked_tp, 6)
                    insight_data["sl_target"] = round(self.locked_sl, 6)
                    
                except Exception as e: 
                    self.logger.debug(f"AI Insight Fetch Error: {e}")

                bot_sys_path = Path("bot_system.json")
                if self.bot.running:
                    insight_data["signal_status"] = insight_data.get("signal_status", "WAIT") + " (BOT_ACTIVE)"
                    if bot_sys_path.exists():
                        try:
                            bot_sys = json.loads(bot_sys_path.read_text().strip())
                            b_data = bot_sys.get("data", {})
                            if isinstance(b_data, dict):
                                b_action = b_data.get("action", "WAIT")
                                b_reason = b_data.get("reason", "")
                                if b_action and b_reason:
                                    insight_data["advice"] = f"[Internal Bot]: {b_action} | {b_reason}\n\n[Eksternal AI]:\n{insight_data.get('advice', '')}"
                        except: pass
                
                try: self.insight_file.write_text(json.dumps(insight_data, indent=2))
                except: pass

# ── HTTP handler ──────────────────────────────────────────────────────────────

class DashboardHandler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    
    def _json(self, data: dict, status: int = 200) -> None:
        try:
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except: pass

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        
        # Router File Statis Terpecah
        if parsed.path == "/" or parsed.path == "/index.html":
            file_path = Path(__file__).parent / "dashboard.html"
            content_type = "text/html; charset=utf-8"
        elif parsed.path == "/dashboard.css":
            file_path = Path(__file__).parent / "dashboard.css"
            content_type = "text/css; charset=utf-8"
        elif parsed.path == "/dashboard.js":
            file_path = Path(__file__).parent / "dashboard.js"
            content_type = "application/javascript; charset=utf-8"
        elif parsed.path == "/favicon.ico":
            self.send_response(204); self.end_headers(); return
        else:
            file_path = None

        if file_path:
            try: 
                body = file_path.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except FileNotFoundError: 
                self.send_error(404, f"File {parsed.path} tidak ditemukan")
            return

        if parsed.path == "/api/logs":
            qs = parse_qs(parsed.query)
            since = int(qs.get("since", ["0"])[0])
            with log_lock:
                new_logs = log_buffer[since:]
                total = len(log_buffer)
            self._json({"logs": new_logs, "total": total, "running": bot.running})
            return
        if parsed.path == "/api/get-env": self._json({"env": read_env()}); return
        if parsed.path == "/api/insight":
            try:
                insight_path = Path("bot_insight.json")
                body = insight_path.read_bytes() if insight_path.exists() else b"{}"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
                self.send_header("Pragma", "no-cache")
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return
        self.send_error(404)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        raw_body = self.rfile.read(length)
        try: body = json.loads(raw_body) if raw_body else {}
        except: body = {}
        
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
                self._json({"ok": True, "message": "Config tersimpan ✓"})
            except Exception as exc: self._json({"ok": False, "message": f"Gagal simpan: {exc}"})
            return
        if self.path == "/api/clear-logs":
            with log_lock: log_buffer.clear()
            self._json({"ok": True})
            return
        self.send_error(404)

def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]; s.close()
        return ip
    except: return "127.0.0.1"

if __name__ == "__main__":
    HOST, PORT = "0.0.0.0", 8765
    local_ip = get_local_ip()
    InsightBackgroundFetcher(bot).start()
    server = HTTPServer((HOST, PORT), DashboardHandler)
    print(f"\n  ⬡  BotTrade Dashboard\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print(f"  PC : http://localhost:{PORT}")
    print(f"  HP : http://{local_ip}:{PORT}")
    print(f"  Ctrl+C untuk keluar\n")
    try: server.serve_forever()
    except KeyboardInterrupt:
        if bot.running: bot.stop()