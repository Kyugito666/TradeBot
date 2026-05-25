@echo off
title TradeBot v3.0 — Go+Rust Zero-Latency

setlocal enabledelayedexpansion

echo ================================================
echo   TradeBot Go+Rust Launcher (Windows)
echo ================================================
echo.

REM ── Check tools ──────────────────────────────────
where go    >nul 2>&1 || (echo [ERR] Go not found. https://go.dev/dl/ & pause & exit /b 1)
where cargo >nul 2>&1 || (echo [ERR] Cargo not found. https://rustup.rs/ & pause & exit /b 1)

REM ── Build Go engine ───────────────────────────────
echo [1/3] Building Go engine...
cd go-engine
go mod tidy -e 2>nul
go build -o go-engine.exe . || (echo [ERR] Go build failed & pause & exit /b 1)
cd ..
echo       Go engine built OK

REM ── Build Rust brain ──────────────────────────────
echo [2/3] Building Rust brain (release)...
cd rust-brain
set RUSTFLAGS=-C target-cpu=native
cargo build --release 2>&1 | findstr /C:"error" /C:"warning" /C:"Compiling" /C:"Finished"
if not exist "target\release\tradebot-brain.exe" (
    echo [ERR] Rust build failed
    pause & exit /b 1
)
cd ..
echo       Rust brain built OK

REM ── Truncate log ──────────────────────────────────
echo. > bot.log

REM ── Step 1: Go engine (creates SHM) ───────────────
echo [3/3] Starting Go engine (port 8765)...
start "Go Engine" cmd /c "go-engine\go-engine.exe >> bot.log 2>&1"

REM Wait for dashboard to come up (polls /api/status)
echo     Waiting for dashboard...
:wait_dashboard
timeout /t 1 /nobreak > nul
curl -sf http://localhost:8765/api/status >nul 2>&1
if errorlevel 1 goto wait_dashboard
echo     Dashboard ready!

REM ── Step 2: Rust brain ────────────────────────────
echo     Starting Rust brain...
start "Rust Brain" cmd /c "set RUST_LOG=info && rust-brain\target\release\tradebot-brain.exe >> bot.log 2>&1"

echo.
echo ================================================
echo   Bot running!
echo   Dashboard  ^> http://localhost:8765
echo   Logs       ^> bot.log
echo   Close both windows to stop.
echo ================================================
echo.
pause
