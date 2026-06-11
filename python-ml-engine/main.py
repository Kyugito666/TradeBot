from fastapi import FastAPI, BackgroundTasks
import os
import uvicorn
from pydantic import BaseModel
import downloader
import converter

from military_room import MilitaryRoom

app = FastAPI(title="TradeBot Python ML Engine")

DB_BASE_PATH = os.environ.get("BOT_DB_DIR", os.environ.get("BOT_DB_PATH", "/mnt/d/database"))
# If someone set BOT_DB_PATH to a file (e.g. agent_evolution.db), use its parent dir
if DB_BASE_PATH.endswith(".db"):
    DB_BASE_PATH = os.path.dirname(os.path.dirname(DB_BASE_PATH))  # strip /brain/file.db
PARQUET_DIR = os.path.join(DB_BASE_PATH, "parquet", "bigdata")
CANDLE_DIR = os.path.join(DB_BASE_PATH, "parquet", "bigdata", "candles")
ORC_DIR = os.path.join(DB_BASE_PATH, "orc", "agents")

military_room = MilitaryRoom()

class MLRequest(BaseModel):
    symbol: str
    timeframe: str

class TrainRequest(BaseModel):
    agent_id: str
    symbol: str = "BTC/USDT"
    timeframe: str = "1h"

class DownloadRequest(BaseModel):
    timeframe: str = "1h"
    max_years: int = 5
    target_symbol: str = None
    
import threading

@app.on_event("startup")
async def startup_event():
    os.makedirs(PARQUET_DIR, exist_ok=True)
    os.makedirs(CANDLE_DIR, exist_ok=True)
    os.makedirs(ORC_DIR, exist_ok=True)
    print(f"[Python ML Engine] Started. Candle path: {CANDLE_DIR}")
    
    # 1) Start binary→ORC/Parquet converter daemon (every 5 minutes)
    converter.start_daemon(interval_seconds=300)
    print("[Python ML Engine] Binary→ORC/Parquet converter daemon started (every 5min)")
    
    # 2) Auto-download candle history in background (incremental)
    def init_background():
        try:
            print("[Python ML Engine] Starting Smart Multi-Exchange Downloader...")
            dl = downloader.get_downloader(max_years=5)
            # Download 1h first (most used), then others
            dl.download_all(timeframes=["1h"])
            # After 1h is done, download other timeframes
            dl.download_all(timeframes=["4h", "1d", "15m"])
        except Exception as e:
            print(f"[Downloader] Background download error: {e}")
            
    t = threading.Thread(target=init_background, daemon=True)
    t.start()

    # 3) Initialize default agents in background
    def init_agents():
        try:
            default_agents = [
                "data_engineer", "economist", "game_theorist", "mathematician", 
                "physicist", "cryptographer", "linguist", "liquidator", 
                "absurdist", "data_scientist", "statistician", "psychologist", "astrophysicist"
            ]
            for agent in default_agents:
                military_room.train_agent(agent, "BTC/USDT", "1h")
        except Exception as e:
            print(f"[Agent Init] Error: {e}")
            
    t2 = threading.Thread(target=init_agents, daemon=True)
    t2.start()

@app.on_event("shutdown")
async def shutdown_event():
    converter.stop_daemon()
    dl = downloader.get_downloader()
    dl.stop()
    print("[Python ML Engine] Shutdown complete")

# ── Agent Training (Military Tatar) ──────────────────────────────────────────

@app.post("/api/ml/train_agent")
async def train_agent(req: TrainRequest):
    result = military_room.train_agent(req.agent_id, req.symbol, req.timeframe)
    return result

class TrainAllRequest(BaseModel):
    timeframe: str = "1h"
    atr_mult: float = 2.0
    rr: float = 2.0
    max_symbols: int = 20

@app.post("/api/ml/train_all_agents")
async def train_all_agents(req: TrainAllRequest, background_tasks: BackgroundTasks):
    def do_train():
        military_room.train_all_agents(
            symbols=None,  # auto-detect from candle data
            timeframe=req.timeframe,
            atr_mult=req.atr_mult,
            rr=req.rr,
        )
    background_tasks.add_task(do_train)
    return {"status": "started", "message": "Training all agents on available candle data in background"}

@app.get("/api/ml/agent_status")
async def agent_status():
    return military_room.get_all_status()

@app.get("/api/ml/graduated_agents")
async def graduated_agents():
    return {"graduated": military_room.get_graduated_agents()}

@app.post("/api/ml/check_demotions")
async def check_demotions():
    demoted = military_room.check_demotions()
    return {"demoted": demoted}

# ── Download Management ──────────────────────────────────────────────────────

@app.post("/api/ml/download_history")
async def trigger_download(req: DownloadRequest, background_tasks: BackgroundTasks):
    def do_download():
        dl = downloader.get_downloader(max_years=req.max_years)
        dl.download_all(
            timeframes=[req.timeframe],
            target_symbol=req.target_symbol,
        )
    background_tasks.add_task(do_download)
    return {
        "status": "started",
        "message": f"Downloading {req.max_years}Y candle history in background ({req.timeframe})"
    }

@app.get("/api/ml/download_status")
async def download_status():
    dl = downloader.get_downloader()
    return {"progress": dl.progress}

@app.post("/api/ml/download_pair")
async def download_pair(req: DownloadRequest, background_tasks: BackgroundTasks):
    if not req.target_symbol:
        return {"ok": False, "error": "target_symbol required"}
    def do_download():
        dl = downloader.get_downloader(max_years=req.max_years)
        dl.download_pair(req.target_symbol, req.timeframe)
    background_tasks.add_task(do_download)
    return {"ok": True, "message": f"Downloading {req.target_symbol} ({req.timeframe})"}

# ── Converter Management ─────────────────────────────────────────────────────

@app.post("/api/ml/convert_now")
async def convert_now(background_tasks: BackgroundTasks):
    background_tasks.add_task(converter.run_conversion)
    return {"ok": True, "message": "Binary→ORC/Parquet conversion started"}

# ── Candle History for Backtest ──────────────────────────────────────────────

class HistoryRequest(BaseModel):
    symbol: str
    exchange: str = "okx"
    timeframe: str = "1h"
    period_days: int = 12

@app.post("/api/ml/get_history")
async def get_history(req: HistoryRequest, background_tasks: BackgroundTasks):
    safe_sym = req.symbol.replace("/", "_")
    
    # Try new candle path first, then legacy path
    candle_file = os.path.join(CANDLE_DIR, f"{safe_sym}_{req.timeframe}.parquet")
    legacy_file = os.path.join(PARQUET_DIR, f"{req.exchange}_{safe_sym}_{req.timeframe}.parquet")
    
    parquet_file = None
    if os.path.exists(candle_file):
        parquet_file = candle_file
    elif os.path.exists(legacy_file):
        parquet_file = legacy_file
    
    if not parquet_file:
        # Trigger download and return empty for now
        def do_dl():
            dl = downloader.get_downloader()
            dl.download_pair(req.symbol, req.timeframe)
        background_tasks.add_task(do_dl)
        return {"ok": False, "error": "History not available yet, downloading in background..."}
        
    import pandas as pd
    try:
        df = pd.read_parquet(parquet_file)
        # Slice the last X days
        cutoff = df['timestamp'].max() - (req.period_days * 24 * 60 * 60 * 1000)
        sliced = df[df['timestamp'] >= cutoff]
        
        return {
            "ok": True,
            "opens": sliced['open'].tolist(),
            "highs": sliced['high'].tolist(),
            "lows": sliced['low'].tolist(),
            "closes": sliced['close'].tolist(),
            "volumes": sliced['volume'].tolist(),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ── ML Evaluation (Stub) ────────────────────────────────────────────────────

@app.post("/api/ml/evaluate")
async def evaluate(req: MLRequest):
    return {
        "signal": "WAIT",
        "confidence": 0.5,
        "reason": "Quantitative ML Evaluation Stub",
        "math_score": 0.0
    }

# ── Paper Trade History (Parquet Persistence) ────────────────────────────────

PAPER_HISTORY_PARQUET = os.path.join(PARQUET_DIR, "paper_history.parquet")
from typing import Dict, Any, List, Union

@app.post("/api/ml/save_paper_history")
async def save_paper_history(trade_data: Union[Dict[str, Any], List[Dict[str, Any]]]):
    import pandas as pd
    
    if isinstance(trade_data, list):
        if len(trade_data) == 0:
            return {"ok": True}
        df_new = pd.DataFrame(trade_data)
    else:
        df_new = pd.DataFrame([trade_data])
        
    if os.path.exists(PAPER_HISTORY_PARQUET):
        try:
            df = pd.read_parquet(PAPER_HISTORY_PARQUET)
            if isinstance(trade_data, list):
                df_new.to_parquet(PAPER_HISTORY_PARQUET, index=False)
            else:
                df = pd.concat([df_new, df], ignore_index=True)
                df = df.drop_duplicates(subset=['id'], keep='first')
                df.to_parquet(PAPER_HISTORY_PARQUET, index=False)
        except Exception:
            df_new.to_parquet(PAPER_HISTORY_PARQUET, index=False)
    else:
        df_new.to_parquet(PAPER_HISTORY_PARQUET, index=False)
    return {"ok": True}

@app.get("/api/ml/get_paper_history")
async def get_paper_history():
    import pandas as pd
    if not os.path.exists(PAPER_HISTORY_PARQUET):
        return []
    try:
        df = pd.read_parquet(PAPER_HISTORY_PARQUET)
        df = df.fillna(0)
        return df.to_dict(orient="records")
    except Exception:
        return []

@app.post("/api/ml/clear_paper_history")
async def clear_paper_history():
    if os.path.exists(PAPER_HISTORY_PARQUET):
        try:
            os.remove(PAPER_HISTORY_PARQUET)
        except:
            pass
    return {"ok": True}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=5000)
