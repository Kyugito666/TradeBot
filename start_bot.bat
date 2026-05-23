@echo off
title TradeBot v2.0 Orchestrator

echo [1/3] Menyalakan Go Data Gateway (Port 7890)...
start "Go Gateway" cmd /c "cd data_gateway && go run main.go"

:: Jeda 3 detik agar Go Gateway memiliki waktu untuk inisialisasi dan koneksi WS
timeout /t 3 /nobreak > nul

echo [2/3] Menyalakan Python Dashboard Server (Port 8765)...
start "Dashboard Server" cmd /c "python bot_server.py"

echo [3/3] Menyalakan Python Execution Engine (Main Logic)...
start "TradeBot Engine" cmd /c "python main.py"

echo.
echo [OK] Seluruh ekosistem TradeBot v2.0 sedang beroperasi di latar belakang.
echo Tutup jendela terminal masing-masing untuk mematikan servis.
pause