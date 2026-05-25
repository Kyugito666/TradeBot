#!/usr/bin/env bash
# start_bot.sh — TradeBot Go+Rust Zero-Latency Launcher
# ======================================================
# Urutan startup kritis:
#   1. Build & start Go engine DULU → Go MEMBUAT segmen SHM
#   2. Tunggu SHM ready (health check)
#   3. Build & start Rust brain → Rust MEMBUKA SHM yang sudah ada
#   4. Semua stdout diarahkan ke bot.log agar dashboard bisa membacanya
#
# Usage:
#   chmod +x start_bot.sh
#   ./start_bot.sh           # normal start
#   ./start_bot.sh --stop    # kill semua proses bot
#   ./start_bot.sh --status  # cek apakah bot berjalan

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
    # Clean SHM segment
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

# ── Preflight checks ──────────────────────────────────────────────────────────
log "=== TradeBot Go+Rust Launcher ==="
command -v go   >/dev/null 2>&1 || { err "Go not found. Install: https://go.dev/dl/"; exit 1; }
command -v cargo >/dev/null 2>&1 || { err "Rust/Cargo not found. Install: https://rustup.rs/"; exit 1; }

GO_VER=$(go version | awk '{print $3}')
RS_VER=$(cargo --version | awk '{print $2}')
log "Go: $GO_VER | Rust: $RS_VER"

[[ -f "$SCRIPT_DIR/.env" ]] || { warn ".env not found — using environment variables only"; }

# ── Build Go engine ───────────────────────────────────────────────────────────
log "Building Go engine..."
cd "$GO_ENGINE_DIR"
go mod tidy -e 2>/dev/null || true
go build -o go-engine-bin . 2>&1 | tee -a "$LOG_FILE"
log "Go engine built ✓"

# ── Build Rust brain ──────────────────────────────────────────────────────────
log "Building Rust brain (release)..."
cd "$RUST_BRAIN_DIR"
RUSTFLAGS="-C target-cpu=native" cargo build --release 2>&1 | tail -5
RUST_BIN="$RUST_BRAIN_DIR/target/release/tradebot-brain"
[[ -f "$RUST_BIN" ]] || { err "Rust build failed — check output above"; exit 1; }
log "Rust brain built ✓"

# ── Clear stale PID file and SHM ─────────────────────────────────────────────
rm -f "$PID_FILE" "$SHM_PATH"
> "$LOG_FILE"  # truncate log

# ── Start Go engine (creates SHM) ─────────────────────────────────────────────
log "Starting Go engine (port $DASHBOARD_PORT)..."
cd "$SCRIPT_DIR"
"$GO_ENGINE_DIR/go-engine-bin" >> "$LOG_FILE" 2>&1 &
GO_PID=$!
echo "$GO_PID" >> "$PID_FILE"
log "Go engine PID: $GO_PID"

# ── Wait for SHM segment to appear ───────────────────────────────────────────
log "Waiting for SHM segment..."
for i in {1..30}; do
    if [[ -f "$SHM_PATH" ]]; then
        log "SHM ready after ${i}s ✓"
        break
    fi
    sleep 1
    [[ $i -eq 30 ]] && { err "SHM not created after 30s — Go engine failed?"; exit 1; }
done

# Also verify HTTP gateway is accepting connections
log "Waiting for dashboard HTTP..."
for i in {1..15}; do
    if curl -sf "http://localhost:$DASHBOARD_PORT/api/status" >/dev/null 2>&1; then
        log "Dashboard ready ✓"
        break
    fi
    sleep 1
    [[ $i -eq 15 ]] && warn "Dashboard not responding (continuing anyway)"
done

# ── Start Rust brain ──────────────────────────────────────────────────────────
log "Starting Rust brain..."
RUST_LOG=info "$RUST_BIN" >> "$LOG_FILE" 2>&1 &
RUST_PID=$!
echo "$RUST_PID" >> "$PID_FILE"
log "Rust brain PID: $RUST_PID"

# ── Summary ───────────────────────────────────────────────────────────────────
sleep 2
echo ""
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log "  Bot running!"
log "  Dashboard  → http://localhost:$DASHBOARD_PORT"
log "  Logs       → tail -f $LOG_FILE"
log "  Stop       → ./start_bot.sh --stop"
log "  Status     → ./start_bot.sh --status"
log "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Monitor: jika salah satu proses mati, log peringatan
(
    while true; do
        sleep 10
        kill -0 "$GO_PID"   2>/dev/null || { echo "[MONITOR] Go engine died!" >> "$LOG_FILE"; }
        kill -0 "$RUST_PID" 2>/dev/null || { echo "[MONITOR] Rust brain died!" >> "$LOG_FILE"; }
    done
) &
echo $! >> "$PID_FILE"
