#!/usr/bin/env bash
# start_bot.sh — TradeBot Go+Rust Zero-Latency Launcher

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/bot.log"
PID_FILE="$SCRIPT_DIR/bot.pid"
GO_ENGINE_DIR="$SCRIPT_DIR/go-engine"
RUST_BRAIN_DIR="$SCRIPT_DIR/rust-brain"
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
command -v go    >/dev/null 2>&1 || { err "Go not found.";    exit 1; }
command -v cargo >/dev/null 2>&1 || { err "Rust not found.";  exit 1; }

GO_VER=$(go version | awk '{print $3}')
RS_VER=$(cargo --version | awk '{print $2}')
log "Go: $GO_VER | Rust: $RS_VER"

# ── Build ─────────────────────────────────────────────────────────────────────
log "Building Go engine..."
cd "$GO_ENGINE_DIR"
go mod tidy -e 2>/dev/null || true
go build -o go-engine-bin . 2>&1 | tee -a "$LOG_FILE"
log "Go engine built ✓"

log "Building Rust brain (release)..."
cd "$RUST_BRAIN_DIR"
RUSTFLAGS="-C target-cpu=native" cargo build --release 2>&1 | tail -5
RUST_BIN="$RUST_BRAIN_DIR/target/release/tradebot-brain"
[[ -f "$RUST_BIN" ]] || { err "Rust build failed"; exit 1; }
log "Rust brain built ✓"

# ── Clear stale state ─────────────────────────────────────────────────────────
rm -f "$PID_FILE" "$SHM_PATH"
> "$LOG_FILE"

# ── start_go — fungsi untuk start/restart Go engine ──────────────────────────
start_go() {
    cd "$SCRIPT_DIR"
    "$GO_ENGINE_DIR/go-engine-bin" >> "$LOG_FILE" 2>&1 &
    GO_PID=$!
    echo "[MONITOR] Go engine started PID=$GO_PID" >> "$LOG_FILE"
}

# ── start_rust — fungsi untuk start/restart Rust brain ───────────────────────
start_rust() {
    # Tunggu SHM ada dulu sebelum start Rust
    local retries=0
    while [[ ! -f "$SHM_PATH" ]] && (( retries < 15 )); do
        sleep 1
        (( retries++ )) || true
    done
    if [[ ! -f "$SHM_PATH" ]]; then
        echo "[MONITOR] ERROR: SHM not found, cannot start Rust brain" >> "$LOG_FILE"
        return 1
    fi
    RUST_LOG=info "$RUST_BIN" >> "$LOG_FILE" 2>&1 &
    RUST_PID=$!
    echo "[MONITOR] Rust brain started PID=$RUST_PID" >> "$LOG_FILE"
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

# Tulis semua PID ke file
{ echo $GO_PID; echo $RUST_PID; } > "$PID_FILE"

log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "  Bot running!"
log "  Dashboard  → http://localhost:$DASHBOARD_PORT"
log "  Logs       → tail -f $LOG_FILE"
log "  Stop       → ./start_bot.sh --stop"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── MONITOR LOOP: auto-restart jika mati ──────────────────────────────────────
# Tidak lagi hanya nulis ke log — langsung restart
while true; do
    sleep 5

    # Cek Go engine
    if ! kill -0 "$GO_PID" 2>/dev/null; then
        echo "[MONITOR] Go engine died! Auto-restarting..." >> "$LOG_FILE"
        # Rust juga harus direstart karena SHM state bisa corrupt
        kill "$RUST_PID" 2>/dev/null || true
        rm -f "$SHM_PATH"
        sleep 1
        start_go
        sleep 3
        start_rust
        { echo $GO_PID; echo $RUST_PID; } > "$PID_FILE"
        echo "[MONITOR] Both processes restarted. GO=$GO_PID RUST=$RUST_PID" >> "$LOG_FILE"
        continue
    fi

    # Cek Rust brain
    if ! kill -0 "$RUST_PID" 2>/dev/null; then
        echo "[MONITOR] Rust brain died! Auto-restarting..." >> "$LOG_FILE"
        start_rust
        echo $RUST_PID >> "$PID_FILE"
        echo "[MONITOR] Rust brain restarted. PID=$RUST_PID" >> "$LOG_FILE"
    fi
done
