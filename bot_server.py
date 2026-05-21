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
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
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
            try:
                db_path = os.environ.get("DB_PATH", "bot_state.db")
                if not os.path.exists(db_path):
                    self._json({"ok": True, "trades": []})
                    return

                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                cursor = conn.cursor()
                cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='active_trades'")
                if cursor.fetchone():
                    cursor.execute("SELECT * FROM active_trades ORDER BY id DESC LIMIT 50")
                    rows = cursor.fetchall()
                    trades = [dict(r) for r in rows]
                else:
                    trades = []
                conn.close()
                self._json({"ok": True, "trades": trades})
            except Exception as exc:
                self._json({"ok": False, "error": str(exc)})
            return

        if parsed.path == "/api/insight":
            try:
                insight_path = Path("bot_insight.json")
                if insight_path.exists():
                    body = insight_path.read_bytes()
                else:
                    body = json.dumps({
                        "timestamp": "-",
                        "trend_state": "WAITING",
                        "whale_bias": "-",
                        "advice": "Menunggu siklus analisis bot selesai (max 1 interval)...",
                        "signal_status": "-"
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

# ── Helper buat dapetin IP Local HP ───────────────────────────────────────────
def get_local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    HOST, PORT = "0.0.0.0", 8765
    local_ip = get_local_ip()
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