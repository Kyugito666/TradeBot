import json
import os
import sys
import subprocess
from http.server import SimpleHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

PORT = 8765

# 1. Kunci semua file ke Absolute Path (Mencegah salah baca folder)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(BASE_DIR, ".env")
INSIGHT_FILE = os.path.join(BASE_DIR, "bot_insight.json")
LOG_FILE = os.path.join(BASE_DIR, "bot.log")
MAIN_SCRIPT = os.path.join(BASE_DIR, "main.py")

# Global tracker untuk proses bot
bot_process = None

class BotServerHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/':
            self.path = '/dashboard.html'
            
        if self.path == '/lw-charts.js':
            self.path = '/static/lw-charts.js'

        parsed_path = urlparse(self.path)

        # Handle API GET request for environment variables
        if '/api/get-env' in parsed_path.path:
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*') 
            self.end_headers()

            env_data = {}
            if os.path.exists(ENV_FILE):
                with open(ENV_FILE, 'r', encoding='utf-8') as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith('#') and '=' in line:
                            key, val = line.split('=', 1)
                            key = key.strip()
                            val = val.strip()
                            # Sanitasi tanda kutip agar aman dibaca frontend
                            if val.startswith('"') and val.endswith('"'): val = val[1:-1]
                            elif val.startswith("'") and val.endswith("'"): val = val[1:-1]
                            env_data[key] = val

            self.wfile.write(json.dumps(env_data).encode('utf-8'))
            return

        if '/favicon.ico' in parsed_path.path:
            self.send_response(204)
            self.end_headers()
            return

        # Handle API GET request for bot insights
        if '/api/insight' in parsed_path.path:
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            if os.path.exists(INSIGHT_FILE):
                with open(INSIGHT_FILE, 'r', encoding='utf-8') as f:
                    self.wfile.write(f.read().encode('utf-8'))
            else:
                self.wfile.write(json.dumps({}).encode('utf-8'))
            return

        # Handle API GET request for logs
        if '/api/logs' in parsed_path.path:
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            if os.path.exists(LOG_FILE):
                with open(LOG_FILE, 'r', encoding='utf-8') as f:
                    logs = [line.strip() for line in f.readlines()[-100:]]
                self.wfile.write(json.dumps(logs).encode('utf-8'))
            else:
                self.wfile.write(json.dumps([]).encode('utf-8'))
            return

        if parsed_path.path.startswith('/api/'):
            self.send_response(404)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(json.dumps({"error": f"API route {parsed_path.path} not implemented"}).encode('utf-8'))
            return

        return super().do_GET()

    def do_POST(self):
        global bot_process
        parsed_path = urlparse(self.path)

        # Handle API POST request to save environment variables
        if '/api/save-env' in parsed_path.path:
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length == 0:
                    raise ValueError("Empty request body")

                post_data = self.rfile.read(content_length)
                env_data = json.loads(post_data.decode('utf-8'))

                with open(ENV_FILE, 'w', encoding='utf-8') as f:
                    for key, value in env_data.items():
                        # Simpan dengan aman menggunakan tanda kutip
                        f.write(f'{key}="{value}"\n')

                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "message": "Environment saved"}).encode('utf-8'))
                
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode('utf-8'))
            return

        # 2. EKSEKUSI BOT START
        if '/api/start' in parsed_path.path:
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            if bot_process is None or bot_process.poll() is not None:
                try:
                    # Jalankan main.py dengan interpreter yang sama, di folder yang sama
                    bot_process = subprocess.Popen([sys.executable, MAIN_SCRIPT], cwd=BASE_DIR)
                    self.wfile.write(json.dumps({"status": "success", "message": "Bot is starting..."}).encode('utf-8'))
                except Exception as e:
                    self.wfile.write(json.dumps({"status": "error", "message": f"Failed to start bot: {e}"}).encode('utf-8'))
            else:
                self.wfile.write(json.dumps({"status": "success", "message": "Bot is already running."}).encode('utf-8'))
            return

        # 3. EKSEKUSI BOT STOP
        if '/api/stop' in parsed_path.path:
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            
            if bot_process is not None and bot_process.poll() is None:
                bot_process.terminate()
                bot_process.wait()
                self.wfile.write(json.dumps({"status": "success", "message": "Bot stopped."}).encode('utf-8'))
            else:
                self.wfile.write(json.dumps({"status": "success", "message": "Bot is not running."}).encode('utf-8'))
            return

        self.send_error(501, "Unsupported method ('POST')")

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

def run_server():
    server_address = ('', PORT)
    httpd = HTTPServer(server_address, BotServerHandler)
    print(f"[SYSTEM] Dashboard server running at http://localhost:{PORT}")
    print(f"[SYSTEM] Absolute path tracking enabled in: {BASE_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[SYSTEM] Shutting down dashboard server...")
        if bot_process is not None and bot_process.poll() is None:
            bot_process.terminate()
        httpd.server_close()

if __name__ == '__main__':
    run_server()