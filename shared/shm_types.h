/**
 * shared/shm_types.h
 * ==================
 * C-ABI Shared Memory Contract between Go (writer) and Rust (reader/writer).
 *
 * Layout (strict, no implicit padding):
 *   [0..63]   : ShmCtrl  — atomic sync block, 64-byte cache-line aligned
 *   [64..]    : MarketData — snapshot written by Go on every loop tick
 *   [64+M..]  : SignalResult — consensus output written by Rust
 *
 * Invariants:
 *   - All structs use ONLY 8-byte primitives except where explicit padding added.
 *   - sizeof(Candle)     = 48  (6 × f64/i64)
 *   - sizeof(MarketData) ≤ 16 KiB
 *   - sizeof(SHM_SIZE)   = 128 KiB
 *
 * Protocol (producer-consumer with volatile seqlock):
 *   Go  : increment go_seq (odd)  → write MarketData → set data_ready=1  → increment go_seq (even)
 *   Rust: spin on data_ready==1   → read go_seq twice (seqlock verify)   → process
 *       → write SignalResult       → set signal_ready=1                   → increment rust_seq
 *   Go  : poll signal_ready==1    → read SignalResult → execute order     → reset signal_ready=0
 */

#pragma once
#include <stdint.h>

/* ── Constants ─────────────────────────────────────────────────────────────── */
#define SHM_NAME        "/tradebot_v3"
#define SHM_SIZE        131072          /* 128 KiB */
#define MAX_CANDLES     200
#define SYM_LEN         16
#define REASON_LEN      256
#define AGENT_COUNT     6

/* Direction tags */
#define DIR_WAIT  0
#define DIR_BUY   1
#define DIR_SELL  2

/* ── Primitive building blocks ─────────────────────────────────────────────── */

/** One OHLCV candle — 48 bytes, zero padding. */
typedef struct {
    double  open;
    double  high;
    double  low;
    double  close;
    double  volume;
    int64_t ts_ms;      /* milliseconds UTC */
} Candle;               /* sizeof = 48 */

/* ── Control block (first 64 bytes of SHM) ─────────────────────────────────── */

typedef struct {
    volatile uint64_t go_seq;           /* Go increments before + after MarketData write (seqlock) */
    volatile uint64_t rust_seq;         /* Rust increments after SignalResult write */
    volatile uint32_t data_ready;       /* 1 = fresh MarketData waiting for Rust */
    volatile uint32_t signal_ready;     /* 1 = fresh SignalResult waiting for Go  */
    uint8_t           _pad[40];         /* pad to 64 bytes */
} ShmCtrl;              /* sizeof = 64 */

/* ── Market snapshot (written by Go) ──────────────────────────────────────── */

typedef struct {
    /* Identity */
    uint8_t  symbol[SYM_LEN];           /* null-terminated ASCII, e.g. "SOLUSDT" */

    /* OHLCV ring buffer — newest candle at index n_candles-1 */
    Candle   candles[MAX_CANDLES];
    uint32_t n_candles;
    uint32_t _pad1;                     /* explicit padding: 4 bytes */

    /* Ticker */
    double   price;
    double   bid;
    double   ask;

    /* Derivatives */
    double   oi;                        /* open interest in contracts */
    double   lsr;                       /* long/short ratio */
    double   atr_14;                    /* Wilder 14-period ATR */
    double   funding_rate;              /* perpetual funding rate */

    /* Absurdist macro inputs */
    double   usdt_delta_pct;            /* USDT supply Δ% — Tether Printer signal */
    double   kimchi_pct;                /* BTC Kimchi premium % */
    double   whale_inflow_usd;          /* net large-address inflow last 1h */
    double   long_liq_1h;              /* USD long liquidations last 1h */
    double   short_liq_1h;             /* USD short liquidations last 1h */

    /* Linguist cache — updated by Go RSS goroutine every 5 min */
    float    sentiment_score;           /* -1.0 (extreme fear) .. +1.0 (extreme greed) */
    uint32_t news_count;                /* number of articles scored */

    int64_t  ts_ms;                     /* snapshot wall-clock ms UTC */
} MarketData;

/* ── Signal result (written by Rust) ─────────────────────────────────────── */

typedef struct {
    uint8_t  action;                    /* DIR_WAIT / DIR_BUY / DIR_SELL */
    uint8_t  veto;                      /* 1 if any veto rule triggered */
    uint8_t  _pad2[6];                  /* align to 8 */

    double   confidence;
    double   entry;
    double   take_profit;
    double   stop_loss;
    double   risk_reward;

    char     veto_reason[REASON_LEN];   /* null-terminated explanation */

    /* Per-agent breakdown (AGENT_COUNT = 6) */
    uint8_t  agent_dirs[AGENT_COUNT];
    uint8_t  _pad3[2];                  /* align agent_convictions to 8 */
    double   agent_convictions[AGENT_COUNT];

    int64_t  ts_ms;
} SignalResult;

/* ── Root SHM layout ─────────────────────────────────────────────────────── */

typedef struct {
    ShmCtrl     ctrl;       /* offset   0, size  64 */
    MarketData  market;     /* offset  64            */
    SignalResult signal;    /* offset  64 + sizeof(MarketData) */
} ShmRoot;

/* Compile-time size checks — will fail on mismatch */
_Static_assert(sizeof(ShmCtrl)    == 64,  "ShmCtrl must be 64 bytes");
_Static_assert(sizeof(Candle)     == 48,  "Candle must be 48 bytes");
_Static_assert(sizeof(ShmRoot)    <= SHM_SIZE, "ShmRoot exceeds SHM_SIZE");
