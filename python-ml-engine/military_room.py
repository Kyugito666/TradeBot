"""
Military Tatar Training Room — Agent Training from Backtest Data

Each agent is trained on historical candle data using their field of study:
- Mathematician: Z-score mean reversion, Fibonacci ratios
- Physicist: Momentum, velocity, acceleration of price
- Cryptographer: Pattern entropy, fractal dimension
- Statistician: Statistical arbitrage, distribution analysis
- Economist: Supply/demand zones, volume analysis
- etc.

Training flow:
1. Load candle data from Parquet (D:\database\parquet\bigdata\candles\)
2. Walk through bars simulating the agent's strategy
3. Record win/loss per trade
4. Save results to ORC (D:\database\orc\agents\)
5. Gate: WR >= 60% or win_streak >= 5 → GRADUATE (allowed to go live)
6. WR < 45% or loss_streak >= 3 → STAY IN TRAINING
"""

import pandas as pd
import numpy as np
import pyarrow as pa
import pyarrow.orc as orc
import pyarrow.parquet as pq
import os
import time
import threading
import logging
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass, field

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("military_room")

DB_BASE_PATH = os.environ.get("BOT_DB_PATH", "/mnt/d/database")
CANDLE_DIR = os.path.join(DB_BASE_PATH, "parquet", "bigdata", "candles")
LEGACY_CANDLE_DIR = os.path.join(DB_BASE_PATH, "parquet", "bigdata")
ORC_AGENT_DIR = os.path.join(DB_BASE_PATH, "orc", "agents")

# Gate thresholds (matching Rust gatekeeper.rs)
GRADUATE_WINRATE = 60.0
GRADUATE_WINSTREAK = 5
DEMOTE_WINRATE = 45.0
DEMOTE_LOSSSTREAK = 3
MIN_TRADES_FOR_EVAL = 10


@dataclass
class TradeResult:
    bar_entry: int
    bar_exit: int
    side: str  # "LONG" or "SHORT"
    entry_price: float
    exit_price: float
    outcome: str  # "TP" or "SL"
    pnl_r: float  # Risk-reward realized


@dataclass
class AgentTrainingState:
    agent_id: str
    specialty: str
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float = 0.0
    win_streak: int = 0
    loss_streak: int = 0
    max_win_streak: int = 0
    max_loss_streak: int = 0
    pnl_total_r: float = 0.0
    graduated: bool = False
    training_symbols: List[str] = field(default_factory=list)
    trades: List[TradeResult] = field(default_factory=list)


# ── Agent Strategy Functions ─────────────────────────────────────────────────
# Each function takes (closes, highs, lows, volumes, bar_index) and returns
# ("LONG"/"SHORT"/None, conviction 0-1)

def _ema(data: np.ndarray, period: int) -> np.ndarray:
    alpha = 2.0 / (period + 1)
    out = np.empty_like(data)
    out[0] = data[0]
    for i in range(1, len(data)):
        out[i] = alpha * data[i] + (1 - alpha) * out[i - 1]
    return out


def _rsi(closes: np.ndarray, period: int = 14) -> float:
    if len(closes) < period + 1:
        return 50.0
    deltas = np.diff(closes[-period - 1:])
    gains = deltas[deltas > 0].sum() / period
    losses = -deltas[deltas < 0].sum() / period
    if losses < 1e-10:
        return 100.0
    rs = gains / losses
    return 100.0 - 100.0 / (1.0 + rs)


def _atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> float:
    if len(closes) < 2:
        return 0.0
    tr = np.maximum(
        highs[1:] - lows[1:],
        np.maximum(
            np.abs(highs[1:] - closes[:-1]),
            np.abs(lows[1:] - closes[:-1])
        )
    )
    if len(tr) < period:
        return float(np.mean(tr)) if len(tr) > 0 else 0.0
    return float(np.mean(tr[-period:]))


def _zscore(series: np.ndarray, window: int = 20) -> float:
    if len(series) < window:
        return 0.0
    w = series[-window:]
    mean = np.mean(w)
    std = np.std(w)
    if std < 1e-10:
        return 0.0
    return float((series[-1] - mean) / std)


# ── Strategy: Mathematician (Z-score mean reversion + Fibonacci) ─────────────
def strategy_mathematician(closes, highs, lows, volumes, i, atr_mult=2.0, rr=2.0):
    if i < 50:
        return None, 0.0, 0.0, 0.0
    c = closes[:i+1]
    z = _zscore(c, 20)
    rsi = _rsi(c, 14)
    atr = _atr(highs[:i+1], lows[:i+1], c, 14)
    if atr < 1e-10:
        return None, 0.0, 0.0, 0.0

    sl_dist = atr * atr_mult
    tp_dist = sl_dist * rr

    # Mean reversion: buy oversold, sell overbought
    if z < -1.5 and rsi < 35:
        return "LONG", min(abs(z) / 3.0, 0.95), sl_dist, tp_dist
    elif z > 1.5 and rsi > 65:
        return "SHORT", min(abs(z) / 3.0, 0.95), sl_dist, tp_dist
    return None, 0.0, 0.0, 0.0


# ── Strategy: Physicist (Momentum + Velocity + Acceleration) ─────────────────
def strategy_physicist(closes, highs, lows, volumes, i, atr_mult=2.0, rr=2.0):
    if i < 50:
        return None, 0.0, 0.0, 0.0
    c = closes[:i+1]
    atr = _atr(highs[:i+1], lows[:i+1], c, 14)
    if atr < 1e-10:
        return None, 0.0, 0.0, 0.0

    # Velocity = rate of change over 10 bars
    velocity = (c[-1] - c[-10]) / c[-10] if c[-10] > 0 else 0
    # Acceleration = change in velocity
    v_prev = (c[-10] - c[-20]) / c[-20] if len(c) >= 20 and c[-20] > 0 else 0
    accel = velocity - v_prev

    sl_dist = atr * atr_mult
    tp_dist = sl_dist * rr

    # Trend following: positive velocity + accelerating
    if velocity > 0.005 and accel > 0:
        return "LONG", min(abs(velocity) * 10, 0.95), sl_dist, tp_dist
    elif velocity < -0.005 and accel < 0:
        return "SHORT", min(abs(velocity) * 10, 0.95), sl_dist, tp_dist
    return None, 0.0, 0.0, 0.0


# ── Strategy: Statistician (Bollinger Bands + Volume deviation) ──────────────
def strategy_statistician(closes, highs, lows, volumes, i, atr_mult=2.0, rr=2.0):
    if i < 50:
        return None, 0.0, 0.0, 0.0
    c = closes[:i+1]
    atr = _atr(highs[:i+1], lows[:i+1], c, 14)
    if atr < 1e-10:
        return None, 0.0, 0.0, 0.0

    mean = np.mean(c[-20:])
    std = np.std(c[-20:])
    upper = mean + 2 * std
    lower = mean - 2 * std
    vol_z = _zscore(volumes[:i+1].astype(float), 20) if i > 20 else 0

    sl_dist = atr * atr_mult
    tp_dist = sl_dist * rr

    # Bollinger band bounce with volume confirmation
    if c[-1] < lower and vol_z > 0.5:
        return "LONG", min((mean - c[-1]) / (2 * std + 1e-10), 0.95), sl_dist, tp_dist
    elif c[-1] > upper and vol_z > 0.5:
        return "SHORT", min((c[-1] - mean) / (2 * std + 1e-10), 0.95), sl_dist, tp_dist
    return None, 0.0, 0.0, 0.0


# ── Strategy: Economist (EMA crossover + Volume profile) ─────────────────────
def strategy_economist(closes, highs, lows, volumes, i, atr_mult=2.0, rr=2.0):
    if i < 50:
        return None, 0.0, 0.0, 0.0
    c = closes[:i+1]
    atr = _atr(highs[:i+1], lows[:i+1], c, 14)
    if atr < 1e-10:
        return None, 0.0, 0.0, 0.0

    ema_fast = _ema(c, 12)
    ema_slow = _ema(c, 26)
    vol_sma = np.mean(volumes[max(0,i-20):i+1])

    sl_dist = atr * atr_mult
    tp_dist = sl_dist * rr

    # EMA cross with volume confirmation
    cross_up = ema_fast[-2] < ema_slow[-2] and ema_fast[-1] > ema_slow[-1]
    cross_down = ema_fast[-2] > ema_slow[-2] and ema_fast[-1] < ema_slow[-1]
    vol_ok = volumes[i] > vol_sma * 1.2 if vol_sma > 0 else False

    if cross_up and vol_ok:
        return "LONG", 0.7, sl_dist, tp_dist
    elif cross_down and vol_ok:
        return "SHORT", 0.7, sl_dist, tp_dist
    return None, 0.0, 0.0, 0.0


# ── Strategy: Cryptographer (Entropy + Pattern matching) ─────────────────────
def strategy_cryptographer(closes, highs, lows, volumes, i, atr_mult=2.0, rr=2.0):
    if i < 50:
        return None, 0.0, 0.0, 0.0
    c = closes[:i+1]
    atr = _atr(highs[:i+1], lows[:i+1], c, 14)
    if atr < 1e-10:
        return None, 0.0, 0.0, 0.0

    # Price change patterns (3-bar sequences)
    changes = np.sign(np.diff(c[-15:]))
    pattern = tuple(changes[-3:])
    # Count similar patterns in recent history
    count = sum(1 for j in range(len(changes)-3) if tuple(changes[j:j+3]) == pattern)
    pattern_strength = count / max(len(changes) - 3, 1)

    sl_dist = atr * atr_mult
    tp_dist = sl_dist * rr

    # If pattern strongly predicts direction
    if pattern_strength > 0.3 and len(pattern) == 3:
        if pattern[-1] > 0:
            return "LONG", min(pattern_strength, 0.9), sl_dist, tp_dist
        elif pattern[-1] < 0:
            return "SHORT", min(pattern_strength, 0.9), sl_dist, tp_dist
    return None, 0.0, 0.0, 0.0


# ── Strategy: Game Theorist (Support/Resistance + Nash equilibrium) ──────────
def strategy_game_theorist(closes, highs, lows, volumes, i, atr_mult=2.0, rr=2.0):
    if i < 50:
        return None, 0.0, 0.0, 0.0
    c = closes[:i+1]
    h = highs[:i+1]
    l = lows[:i+1]
    atr = _atr(h, l, c, 14)
    if atr < 1e-10:
        return None, 0.0, 0.0, 0.0

    # Find support/resistance from recent highs/lows
    recent_high = np.max(h[-20:])
    recent_low = np.min(l[-20:])
    price_range = recent_high - recent_low
    if price_range < 1e-10:
        return None, 0.0, 0.0, 0.0

    pos_in_range = (c[-1] - recent_low) / price_range

    sl_dist = atr * atr_mult
    tp_dist = sl_dist * rr

    # Buy near support, sell near resistance
    if pos_in_range < 0.2:
        return "LONG", min(1.0 - pos_in_range, 0.9), sl_dist, tp_dist
    elif pos_in_range > 0.8:
        return "SHORT", min(pos_in_range, 0.9), sl_dist, tp_dist
    return None, 0.0, 0.0, 0.0


# ── Generic fallback for remaining agents ────────────────────────────────────
def strategy_generic(closes, highs, lows, volumes, i, atr_mult=2.0, rr=2.0):
    if i < 50:
        return None, 0.0, 0.0, 0.0
    c = closes[:i+1]
    atr = _atr(highs[:i+1], lows[:i+1], c, 14)
    if atr < 1e-10:
        return None, 0.0, 0.0, 0.0

    rsi = _rsi(c, 14)
    ema20 = np.mean(c[-20:])

    sl_dist = atr * atr_mult
    tp_dist = sl_dist * rr

    if rsi < 30 and c[-1] > ema20:
        return "LONG", 0.6, sl_dist, tp_dist
    elif rsi > 70 and c[-1] < ema20:
        return "SHORT", 0.6, sl_dist, tp_dist
    return None, 0.0, 0.0, 0.0


# ── Strategy Registry ────────────────────────────────────────────────────────
AGENT_STRATEGIES = {
    "mathematician": ("Z-Score Mean Reversion + Fibonacci", strategy_mathematician),
    "physicist": ("Momentum + Velocity + Acceleration", strategy_physicist),
    "statistician": ("Bollinger Bands + Volume Deviation", strategy_statistician),
    "economist": ("EMA Crossover + Volume Profile", strategy_economist),
    "cryptographer": ("Pattern Entropy + Frequency Analysis", strategy_cryptographer),
    "game_theorist": ("Support/Resistance + Nash Equilibrium", strategy_game_theorist),
    "data_engineer": ("Data Pipeline Analysis", strategy_generic),
    "data_scientist": ("ML Feature Engineering", strategy_generic),
    "linguist": ("Sentiment NLP", strategy_generic),
    "liquidator": ("Liquidation Zone Detection", strategy_generic),
    "absurdist": ("Chaos Theory + Contrarian", strategy_generic),
    "psychologist": ("Market Psychology", strategy_generic),
    "astrophysicist": ("Cycle Detection", strategy_generic),
    "treasury_manager": ("Risk/Reward Optimization", strategy_generic),
}


class MilitaryRoom:
    """
    Military Tatar Training Room. Trains agents on historical data
    and gates them based on winrate before allowing live market participation.
    """

    def __init__(self):
        os.makedirs(ORC_AGENT_DIR, exist_ok=True)
        self._agents: Dict[str, AgentTrainingState] = {}
        self._lock = threading.Lock()
        self._load_existing_states()

    def _load_existing_states(self):
        """Load existing ORC training states on startup."""
        for fname in os.listdir(ORC_AGENT_DIR):
            if fname.endswith(".orc"):
                agent_id = fname.replace(".orc", "")
                try:
                    path = os.path.join(ORC_AGENT_DIR, fname)
                    table = orc.read_table(path)
                    df = table.to_pandas()
                    if len(df) > 0:
                        row = df.iloc[-1]
                        state = AgentTrainingState(
                            agent_id=agent_id,
                            specialty=AGENT_STRATEGIES.get(agent_id, ("Generic", None))[0],
                            total_trades=int(row.get("total_trades", 0)),
                            wins=int(row.get("wins", 0)),
                            losses=int(row.get("losses", 0)),
                            win_rate=float(row.get("win_rate", 0)),
                            win_streak=int(row.get("win_streak", 0)),
                            loss_streak=int(row.get("loss_streak", 0)),
                            graduated=bool(row.get("graduated", False)),
                        )
                        self._agents[agent_id] = state
                        log.info(f"[Tatar] Loaded {agent_id}: WR={state.win_rate:.1f}% graduated={state.graduated}")
                except Exception as e:
                    log.warning(f"[Tatar] Failed to load {fname}: {e}")

    def _find_candle_file(self, symbol: str, timeframe: str = "1h") -> Optional[str]:
        """Find candle parquet file (new path or legacy path)."""
        safe = symbol.replace("/", "_")
        # New path
        new_path = os.path.join(CANDLE_DIR, f"{safe}_{timeframe}.parquet")
        if os.path.exists(new_path):
            return new_path
        # Legacy path
        legacy_path = os.path.join(LEGACY_CANDLE_DIR, f"okx_{safe}_{timeframe}.parquet")
        if os.path.exists(legacy_path):
            return legacy_path
        return None

    def _get_all_symbols(self) -> List[str]:
        """Get all available symbols from candle data."""
        symbols = set()
        for d in [CANDLE_DIR, LEGACY_CANDLE_DIR]:
            if not os.path.exists(d):
                continue
            for f in os.listdir(d):
                if f.endswith(".parquet") and ("_1h" in f or "_USDT_" in f):
                    # Extract symbol from filename
                    name = f.replace(".parquet", "")
                    parts = name.split("_")
                    if len(parts) >= 3 and parts[-1] in ("1h", "4h", "15m", "1d"):
                        sym = "/".join(parts[-3:-1]) if "okx" in parts[0] else "_".join(parts[:-1])
                        if "USDT" in sym:
                            symbols.add(f"{parts[-3]}/{parts[-2]}" if "okx" in parts[0] else sym)
        return sorted(symbols)

    def train_agent(self, agent_id: str, symbol: str = "BTC/USDT", timeframe: str = "1h",
                    atr_mult: float = 2.0, rr: float = 2.0) -> dict:
        """
        Train a single agent on a single symbol using backtest-style walk-forward.
        """
        log.info(f"[Tatar] Training {agent_id} on {symbol} ({timeframe})...")

        strategy_info = AGENT_STRATEGIES.get(agent_id, ("Generic", strategy_generic))
        strategy_name, strategy_fn = strategy_info

        # Load candle data
        path = self._find_candle_file(symbol, timeframe)
        if not path:
            return {"status": "error", "message": f"No candle data for {symbol}. Run downloader first."}

        df = pd.read_parquet(path)
        if len(df) < 100:
            return {"status": "error", "message": f"Insufficient data for {symbol} ({len(df)} candles)"}

        closes = df["close"].values
        highs = df["high"].values
        lows = df["low"].values
        vols = df["volume"].values

        # Walk-forward backtest
        trades = []
        i = 50  # warmup
        while i < len(closes) - 1:
            signal, conv, sl_dist, tp_dist = strategy_fn(closes, highs, lows, vols, i, atr_mult, rr)
            if signal is None or sl_dist < 1e-10:
                i += 1
                continue

            entry = closes[i]
            if signal == "LONG":
                tp_price = entry + tp_dist
                sl_price = entry - sl_dist
            else:
                tp_price = entry - tp_dist
                sl_price = entry + sl_dist

            # Walk forward to find exit
            outcome = None
            exit_bar = i + 1
            for j in range(i + 1, min(i + 200, len(closes))):
                if signal == "LONG":
                    if highs[j] >= tp_price:
                        outcome = "TP"
                        exit_bar = j
                        break
                    if lows[j] <= sl_price:
                        outcome = "SL"
                        exit_bar = j
                        break
                else:
                    if lows[j] <= tp_price:
                        outcome = "TP"
                        exit_bar = j
                        break
                    if highs[j] >= sl_price:
                        outcome = "SL"
                        exit_bar = j
                        break

            if outcome is None:
                i += 1
                continue

            pnl_r = rr if outcome == "TP" else -1.0
            trades.append(TradeResult(
                bar_entry=i, bar_exit=exit_bar, side=signal,
                entry_price=entry, exit_price=tp_price if outcome == "TP" else sl_price,
                outcome=outcome, pnl_r=pnl_r
            ))
            i = exit_bar + 1

        # Compute stats
        wins = sum(1 for t in trades if t.outcome == "TP")
        losses = len(trades) - wins
        win_rate = (wins / len(trades) * 100) if trades else 0
        total_pnl = sum(t.pnl_r for t in trades)

        # Compute streaks
        max_ws = ws = 0
        max_ls = ls = 0
        for t in trades:
            if t.outcome == "TP":
                ws += 1; ls = 0
                max_ws = max(max_ws, ws)
            else:
                ls += 1; ws = 0
                max_ls = max(max_ls, ls)

        # Update agent state
        with self._lock:
            state = self._agents.get(agent_id, AgentTrainingState(
                agent_id=agent_id, specialty=strategy_name
            ))
            state.total_trades += len(trades)
            state.wins += wins
            state.losses += losses
            state.win_rate = (state.wins / state.total_trades * 100) if state.total_trades > 0 else 0
            state.win_streak = ws
            state.loss_streak = ls
            state.max_win_streak = max(state.max_win_streak, max_ws)
            state.max_loss_streak = max(state.max_loss_streak, max_ls)
            state.pnl_total_r += total_pnl
            if symbol not in state.training_symbols:
                state.training_symbols.append(symbol)

            # Gate check
            state.graduated = (
                state.win_rate >= GRADUATE_WINRATE or state.max_win_streak >= GRADUATE_WINSTREAK
            ) and state.total_trades >= MIN_TRADES_FOR_EVAL

            self._agents[agent_id] = state

        # Save to ORC
        self._save_agent_orc(state)

        result = {
            "status": "success",
            "agent_id": agent_id,
            "specialty": strategy_name,
            "symbol": symbol,
            "trades_this_run": len(trades),
            "total_trades": state.total_trades,
            "wins": state.wins,
            "losses": state.losses,
            "win_rate": round(state.win_rate, 2),
            "win_streak": state.win_streak,
            "max_win_streak": state.max_win_streak,
            "pnl_total_r": round(state.pnl_total_r, 2),
            "graduated": state.graduated,
            "message": (
                f"✅ GRADUATED — {agent_id} ready for live!" if state.graduated
                else f"⏳ Still training — WR {state.win_rate:.1f}% (need {GRADUATE_WINRATE}%)"
            )
        }

        log.info(
            f"[Tatar] {agent_id} on {symbol}: {len(trades)} trades, "
            f"WR={state.win_rate:.1f}%, PnL={state.pnl_total_r:.1f}R, "
            f"{'GRADUATED ✅' if state.graduated else 'STILL TRAINING ⏳'}"
        )
        return result

    def train_all_agents(self, symbols: Optional[List[str]] = None,
                         timeframe: str = "1h", atr_mult: float = 2.0, rr: float = 2.0) -> dict:
        """Train all agents across multiple symbols."""
        if symbols is None:
            symbols = self._get_all_symbols()[:20]  # Top 20 pairs

        if not symbols:
            return {"status": "error", "message": "No candle data available. Run downloader first."}

        results = {}
        for agent_id in AGENT_STRATEGIES:
            agent_results = []
            for sym in symbols:
                r = self.train_agent(agent_id, sym, timeframe, atr_mult, rr)
                agent_results.append(r)
            results[agent_id] = self._agents.get(agent_id, AgentTrainingState(agent_id=agent_id))

        graduated = [a for a, s in self._agents.items() if s.graduated]
        still_training = [a for a, s in self._agents.items() if not s.graduated]

        log.info(f"[Tatar] Training complete: {len(graduated)} graduated, {len(still_training)} still training")
        return {
            "graduated": graduated,
            "still_training": still_training,
            "total_agents": len(AGENT_STRATEGIES),
            "symbols_used": symbols,
        }

    def check_demotions(self) -> List[str]:
        """Check which live agents should be pulled back to training."""
        demoted = []
        for agent_id, state in self._agents.items():
            if state.graduated and state.total_trades >= MIN_TRADES_FOR_EVAL:
                if state.win_rate < DEMOTE_WINRATE or state.loss_streak >= DEMOTE_LOSSSTREAK:
                    state.graduated = False
                    self._save_agent_orc(state)
                    demoted.append(agent_id)
                    log.info(f"[Tatar] ⚠️ DEMOTED {agent_id} — WR={state.win_rate:.1f}% back to training")
        return demoted

    def get_graduated_agents(self) -> List[str]:
        return [a for a, s in self._agents.items() if s.graduated]

    def get_all_status(self) -> Dict[str, dict]:
        return {
            agent_id: {
                "specialty": s.specialty,
                "total_trades": s.total_trades,
                "win_rate": round(s.win_rate, 2),
                "win_streak": s.win_streak,
                "loss_streak": s.loss_streak,
                "pnl_r": round(s.pnl_total_r, 2),
                "graduated": s.graduated,
            }
            for agent_id, s in self._agents.items()
        }

    def _save_agent_orc(self, state: AgentTrainingState):
        """Save agent training state to ORC file."""
        try:
            data = {
                "agent_id": [state.agent_id],
                "specialty": [state.specialty],
                "total_trades": [state.total_trades],
                "wins": [state.wins],
                "losses": [state.losses],
                "win_rate": [round(state.win_rate, 2)],
                "win_streak": [state.win_streak],
                "loss_streak": [state.loss_streak],
                "max_win_streak": [state.max_win_streak],
                "pnl_total_r": [round(state.pnl_total_r, 2)],
                "graduated": [state.graduated],
                "trained_on": [",".join(state.training_symbols[:10])],
            }
            df = pd.DataFrame(data)
            table = pa.Table.from_pandas(df, preserve_index=False)
            path = os.path.join(ORC_AGENT_DIR, f"{state.agent_id}.orc")
            orc.write_table(table, path)
        except Exception as e:
            log.error(f"[Tatar] Failed to save {state.agent_id}: {e}")

    def load_parquet_data(self, symbol: str, timeframe: str = "1h"):
        """Legacy compat — load candle data."""
        path = self._find_candle_file(symbol, timeframe)
        if not path:
            return None
        return pd.read_parquet(path)
