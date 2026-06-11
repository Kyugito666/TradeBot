#!/usr/bin/env bash
# start_bot.sh — TradeBot Go+Rust+Python Launcher
# ALL data goes to /mnt/d/database (D:\database on Windows)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    source "$SCRIPT_DIR/.env"
    set +a
fi

# ═══════════════════════════════════════════════════════════════════════════════
# DATABASE PATH — EVERYTHING GOES HERE, NOT IN ROOT PROJECT DIR
# ═══════════════════════════════════════════════════════════════════════════════
DB_BASE_DIR="/mnt/d/database"
export BOT_DB_DIR="$DB_BASE_DIR"
export BOT_DB_PATH="$DB_BASE_DIR/brain/agent_evolution.db"
export BOT_BASE_DIR="$DB_BASE_DIR/engine"
export BOT_LOG_PATH="$DB_BASE_DIR/logs/bot.log"

mkdir -p "$DB_BASE_DIR/logs" "$DB_BASE_DIR/brain" "$DB_BASE_DIR/engine" "$DB_BASE_DIR/parquet" "$DB_BASE_DIR/orc"

LOG_FILE="$BOT_LOG_PATH"
PID_FILE="$SCRIPT_DIR/bot.pid"
GO_ENGINE_DIR="$SCRIPT_DIR/go-engine"
RUST_BRAIN_DIR="$SCRIPT_DIR/rust-brain"
PYTHON_ML_DIR="$SCRIPT_DIR/python-ml-engine"
SHM_PATH="/dev/shm/tradebot_v3"
DASHBOARD_PORT=8765

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}[BOT]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERR]${NC} $*" >&2; }

# ── --stop ────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--stop" ]]; then
    log "Stopping bot processes..."
    if [[ -f "$PID_FILE" ]]; then
        while read -r pid; do
            kill "$pid" 2>/dev/null && log "Killed PID $pid" || true
        done < "$PID_FILE"
        rm -f "$PID_FILE"
    fi
    pkill -f "tradebot-brain" 2>/dev/null || true
    pkill -f "go-engine"      2>/dev/null || true
    pkill -f "python3 main.py" 2>/dev/null || true
    rm -f "$SHM_PATH" 2>/dev/null || true
    log "Done."
    exit 0
fi

# ── --status ──────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--status" ]]; then
    if [[ -f "$PID_FILE" ]]; then
        echo "PID file found:"
        while read -r pid; do
            if kill -0 "$pid" 2>/dev/null; then
                echo "  PID $pid — RUNNING"
            else
                echo "  PID $pid — DEAD"
            fi
        done < "$PID_FILE"
    else
        echo "No PID file. Bot is likely stopped."
    fi
    [[ -f "$SHM_PATH" ]] && echo "SHM segment: EXISTS" || echo "SHM segment: ABSENT"
    exit 0
fi

# ── Preflight ─────────────────────────────────────────────────────────────────
log "=== TradeBot Go+Rust Launcher ==="
log "DB_BASE_DIR = $DB_BASE_DIR"
command -v go    >/dev/null 2>&1 || { err "Go not found.";    exit 1; }
command -v cargo >/dev/null 2>&1 || { err "Rust not found.";  exit 1; }
command -v python3 >/dev/null 2>&1 || { err "Python3 not found."; exit 1; }

GO_VER=$(go version | awk '{print $3}')
RS_VER=$(cargo --version | awk '{print $2}')
PY_VER=$(python3 --version 2>&1)
log "Go: $GO_VER | Rust: $RS_VER | Python: $PY_VER"

# ── Build ─────────────────────────────────────────────────────────────────────
log "Building Go engine..."
cd "$GO_ENGINE_DIR"
go mod tidy -e 2>/dev/null || true
go build -o go-engine-bin . 2>&1
log "Go engine built ✓"

log "Building Rust brain (release)..."
cd "$RUST_BRAIN_DIR"
RUSTFLAGS="-C target-cpu=native" cargo build --release 2>&1
RUST_BIN="$RUST_BRAIN_DIR/target/release/tradebot-brain"
[[ -f "$RUST_BIN" ]] || { err "Rust build failed"; exit 1; }
log "Rust brain built ✓"

log "Setting up Python ML Engine..."
cd "$PYTHON_ML_DIR"
if [ ! -d "venv" ]; then
    python3 -m venv venv
fi
source venv/bin/activate
pip3 install -r requirements.txt > /dev/null 2>&1
log "Python ML Engine ready ✓"

# ── Clear stale state ─────────────────────────────────────────────────────────
rm -f "$PID_FILE" "$SHM_PATH"
> "$LOG_FILE"

# ── start_go — Go engine uses BOT_BASE_DIR for configs ───────────────────────
start_go() {
    cd "$DB_BASE_DIR/engine"
    "$GO_ENGINE_DIR/go-engine-bin" >> "$LOG_FILE" 2>&1 &
    GO_PID=$!
    echo "[MONITOR] Go engine started PID=$GO_PID (CWD=$DB_BASE_DIR/engine)" >> "$LOG_FILE"
}

# ── start_rust ───────────────────────────────────────────────────────────────
start_rust() {
    local retries=0
    while [[ ! -f "$SHM_PATH" ]] && (( retries < 15 )); do
        sleep 1
        (( retries++ )) || true
    done
    if [[ ! -f "$SHM_PATH" ]]; then
        echo "[MONITOR] ERROR: SHM not found after 15s, cannot start Rust brain" >> "$LOG_FILE"
        return 1
    fi
    RUST_LOG=info "$RUST_BIN" >> "$LOG_FILE" 2>&1 &
    RUST_PID=$!
    echo "[MONITOR] Rust brain started PID=$RUST_PID" >> "$LOG_FILE"
}

# ── start_python ─────────────────────────────────────────────────────────────
start_python() {
    cd "$PYTHON_ML_DIR"
    source venv/bin/activate
    python3 main.py >> "$LOG_FILE" 2>&1 &
    PY_PID=$!
    echo "[MONITOR] Python ML Engine started PID=$PY_PID" >> "$LOG_FILE"
}

# ── Initial start ─────────────────────────────────────────────────────────────
log "Starting Go engine (port $DASHBOARD_PORT)..."
start_go

log "Waiting for SHM segment..."
for i in {1..30}; do
    [[ -f "$SHM_PATH" ]] && { log "SHM ready ✓"; break; }
    sleep 1
    [[ $i -eq 30 ]] && { err "SHM not created after 30s"; exit 1; }
done

log "Waiting for dashboard HTTP..."
for i in {1..15}; do
    curl -sf "http://localhost:$DASHBOARD_PORT/api/status" >/dev/null 2>&1 && { log "Dashboard ready ✓"; break; }
    sleep 1
done

log "Starting Rust brain..."
start_rust

log "Starting Python ML Engine..."
start_python

# Tulis semua PID ke file
{ echo $GO_PID; echo $RUST_PID; echo $PY_PID; } > "$PID_FILE"

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "  Bot Backend running!"
log "  Database    → $DB_BASE_DIR"
log "  Gateway API → http://localhost:$DASHBOARD_PORT"
log "  Rust API    → http://localhost:8080"
log "  Python ML   → http://localhost:5000"
log "  Next.js UI  → Run 'npm run dev' & open http://localhost:3000"
log "  Logs        → tail -f $LOG_FILE"
log "  Stop        → ./start_bot.sh --stop"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── MONITOR LOOP ──────────────────────────────────────────────────────────────
while true; do
    sleep 5

    if ! kill -0 "$GO_PID" 2>/dev/null; then
        echo "[MONITOR] Go engine died! Auto-restarting..." >> "$LOG_FILE"
        kill "$RUST_PID" 2>/dev/null || true
        rm -f "$SHM_PATH"
        sleep 1
        start_go
        start_rust
        { echo $GO_PID; echo $RUST_PID; echo $PY_PID; } > "$PID_FILE"
        continue
    fi

    if ! kill -0 "$RUST_PID" 2>/dev/null; then
        echo "[MONITOR] Rust brain died! Auto-restarting..." >> "$LOG_FILE"
        start_rust
        { echo $GO_PID; echo $RUST_PID; echo $PY_PID; } > "$PID_FILE"
        continue
    fi

    if ! kill -0 "$PY_PID" 2>/dev/null; then
        echo "[MONITOR] Python ML died! Auto-restarting..." >> "$LOG_FILE"
        start_python
        { echo $GO_PID; echo $RUST_PID; echo $PY_PID; } > "$PID_FILE"
        continue
    fi
done
