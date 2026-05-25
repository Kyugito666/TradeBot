@echo off
title TradeBot v2.0 Orchestrator

echo [1/2] Menyalakan Go Data Gateway (Port 7890)...
start "Go Gateway" cmd /k "cd data_gateaway && go build -o gateway.exe main.go && gateway.exe"

timeout /t 3 /nobreak > nul

echo [2/2] Menyalakan Python Dashboard Server (Port 8765)...
start "Dashboard Server" cmd /k "call .venv\Scripts\activate && python bot_server.py"