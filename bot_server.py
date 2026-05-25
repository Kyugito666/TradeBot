import json
import os
import re
import sys
import subprocess
from http.server import SimpleHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

PORT = 8765

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(BASE_DIR, ".env")
INSIGHT_FILE = os.path.join(BASE_DIR, "bot_insight.json")
LOG_FILE = os.path.join(BASE_DIR, "bot.log")
MAIN_SCRIPT = os.path.join(BASE_DIR, "main.py")

bot_process = None

# Regex untuk parse log format: "2024-01-01 12:00:00,123 [INFO] module.name - message"
LOG_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ \[(\w+)\] (.+?) - (.+)$'
)

def parse_log_line(line):
    m = LOG_RE.match(line.strip())
    if m:
        return {"ts": m.group(1)[11:16], "level": m.group(2), "name": m.group(3)[-14:], "msg": m.group(4)}
    return {"ts": "--:--", "level": "INFO", "name": "bot", "msg": line.strip()}

def is_bot_running():
    global bot_process
    return bot_process is not None and bot_process.poll() is None

class BotServerHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress access logs

    def do_GET(self):
        if self.path == '/':
            self.path = '/dashboard.html'
        if self.path == '/lw-charts.js':
            self.path = '/static/lw-charts.js'

        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        # ── GET /api/get-env ──────────────────────────────────────────────────
        if '/api/get-env' in parsed.path:
            env_data = {}
            if os.path.exists(ENV_FILE):
                with open(ENV_FILE, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if not line or line.startswith('#') or '=' not in line:
                            continue
                        key, val = line.split('=', 1)
                        val = val.strip().strip('"').strip("'")
                        env_data[key.strip()] = val
            self._json({"env": env_data})  # FIX: wrapped in {env: ...}
            return

        # ── GET /api/insight ──────────────────────────────────────────────────
        if '/api/insight' in parsed.path:
            payload = {}
            if os.path.exists(INSIGHT_FILE):
                try:
                    with open(INSIGHT_FILE, 'r', encoding='utf-8') as f:
                        payload = json.load(f)
                except Exception:
                    pass
            self._json(payload)
            return

        # ── GET /api/logs ─────────────────────────────────────────────────────
        if '/api/logs' in parsed.path:
            since = int(qs.get('since', ['0'])[0])
            all_lines = []
            if os.path.exists(LOG_FILE):
                with open(LOG_FILE, 'r', encoding='utf-8', errors='replace') as f:
                    all_lines = f.readlines()
            # Hanya kirim 500 baris terakhir supaya tidak overload
            all_lines = all_lines[-500:]
            new_lines = all_lines[since:]
            parsed_logs = [parse_log_line(l) for l in new_lines if l.strip()]
            self._json({
                "logs": parsed_logs,
                "total": len(all_lines),
                "running": is_bot_running()
            })
            return

        # ── GET /api/status ───────────────────────────────────────────────────
        if '/api/status' in parsed.path:
            self._json({"running": is_bot_running()})
            return

        if '/favicon.ico' in parsed.path:
            self.send_response(204)
            self.end_headers()
            return

        if parsed.path.startswith('/api/'):
            self.send_response(404)
            self._json({"error": f"Route {parsed.path} not found"})
            return

        return super().do_GET()

    def do_POST(self):
        global bot_process
        parsed = urlparse(self.path)

        # ── POST /api/save-env ────────────────────────────────────────────────
        if '/api/save-env' in parsed.path:
            try:
                length = int(self.headers.get('Content-Length', 0))
                if length == 0:
                    raise ValueError("Empty body")
                data = json.loads(self.rfile.read(length).decode('utf-8'))
                with open(ENV_FILE, 'w', encoding='utf-8') as f:
                    for k, v in data.items():
                        f.write(f'{k}="{v}"\n')
                self._json({"ok": True, "message": "Config saved"})
            except Exception as e:
                self._json({"ok": False, "message": str(e)}, 500)
            return

        # ── POST /api/start ───────────────────────────────────────────────────
        if '/api/start' in parsed.path:
            if is_bot_running():
                self._json({"ok": True, "message": "Bot sudah berjalan."})
                return
            try:
                # Baca .env dan injeksi ke environment anak proses
                env = os.environ.copy()
                if os.path.exists(ENV_FILE):
                    with open(ENV_FILE, 'r', encoding='utf-8') as f:
                        for line in f:
                            line = line.strip()
                            if not line or line.startswith('#') or '=' not in line:
                                continue
                            k, v = line.split('=', 1)
                            env[k.strip()] = v.strip().strip('"').strip("'")

                # Arahkan stdout/stderr ke log file agar bisa dibaca dashboard
                log_fd = open(LOG_FILE, 'a', encoding='utf-8')
                bot_process = subprocess.Popen(
                    [sys.executable, MAIN_SCRIPT],
                    cwd=BASE_DIR,
                    env=env,
                    stdout=log_fd,
                    stderr=log_fd
                )
                self._json({"ok": True, "message": "Bot starting..."})
            except Exception as e:
                self._json({"ok": False, "message": str(e)}, 500)
            return

        # ── POST /api/stop ────────────────────────────────────────────────────
        if '/api/stop' in parsed.path:
            if bot_process is not None and bot_process.poll() is None:
                bot_process.terminate()
                try:
                    bot_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    bot_process.kill()
                self._json({"ok": True, "message": "Bot dihentikan."})
            else:
                self._json({"ok": True, "message": "Bot tidak berjalan."})
            return

        # ── POST /api/clear-logs ──────────────────────────────────────────────
        if '/api/clear-logs' in parsed.path:
            try:
                open(LOG_FILE, 'w').close()
                self._json({"ok": True})
            except Exception as e:
                self._json({"ok": False, "message": str(e)}, 500)
            return

        self.send_error(501, "Not Implemented")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _json(self, payload, code=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def run_server():
    httpd = HTTPServer(('', PORT), BotServerHandler)
    print(f"[SYSTEM] Dashboard: http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        if is_bot_running():
            bot_process.terminate()
        httpd.server_close()
        print("\n[SYSTEM] Server stopped.")

if __name__ == '__main__':
    run_server()