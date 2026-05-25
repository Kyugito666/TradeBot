// rust-brain/src/shm.rs
//
// Cross-process shared memory bridge.
//
// Seqlock protocol (mirror of shm_types.h contract):
//   READ  : spin until go_seq is even (no write in flight)
//           copy market data; re-read go_seq; if changed → retry
//   WRITE : write signal data; fence; set signal_ready = 1; rust_seq++

use std::sync::atomic::{fence, Ordering};
use std::time::{Duration, Instant};

use libc::{c_void, mmap, shm_open, MAP_FAILED, MAP_SHARED, O_RDWR, PROT_READ, PROT_WRITE};
use memmap2::MmapMut;

// ── Constants matching shm_types.h ──────────────────────────────────────────

pub const SHM_NAME:     &str   = "/tradebot_v3";
pub const SHM_SIZE:     usize  = 131_072;
pub const MAX_CANDLES:  usize  = 200;
pub const AGENT_COUNT:  usize  = 6;
pub const REASON_LEN:   usize  = 256;
pub const SYM_LEN:      usize  = 16;

// Byte offsets within ShmRoot
const OFF_CTRL:   usize = 0;
const OFF_GO_SEQ: usize = 0;  // u64 at offset 0
const OFF_RS_SEQ: usize = 8;  // u64 at offset 8
const OFF_DREADY: usize = 16; // u32 at offset 16
const OFF_SREADY: usize = 20; // u32 at offset 20
const OFF_MARKET: usize = 64; // MarketData starts at byte 64

// ── Public data types ────────────────────────────────────────────────────────

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction { Wait = 0, Buy = 1, Sell = 2 }

impl From<u8> for Direction {
    fn from(v: u8) -> Self { match v { 1 => Self::Buy, 2 => Self::Sell, _ => Self::Wait } }
}

#[derive(Debug, Clone, Copy)]
pub struct Candle {
    pub open: f64, pub high: f64, pub low: f64,
    pub close: f64, pub vol: f64, pub ts_ms: i64,
}

/// Owned snapshot of MarketData, safe to use in pure Rust code.
#[derive(Debug, Clone)]
pub struct MarketSnapshot {
    pub symbol:           [u8; SYM_LEN],
    pub candles:          Vec<Candle>,   // length == n_candles (up to MAX_CANDLES)
    pub price:            f64,
    pub bid:              f64,
    pub ask:              f64,
    pub oi:               f64,
    pub lsr:              f64,
    pub atr_14:           f64,
    pub funding_rate:     f64,
    pub usdt_delta_pct:   f64,
    pub kimchi_pct:       f64,
    pub whale_inflow_usd: f64,
    pub long_liq_1h:      f64,
    pub short_liq_1h:     f64,
    pub sentiment_score:  f32,
    pub news_count:       u32,
    pub ts_ms:            i64,
}

pub struct SignalOutput {
    pub action:            Direction,
    pub confidence:        f64,
    pub entry:             f64,
    pub take_profit:       f64,
    pub stop_loss:         f64,
    pub risk_reward:       f64,
    pub veto:              bool,
    pub veto_reason:       String,
    pub agent_dirs:        [u8; AGENT_COUNT],
    pub agent_convictions: [f64; AGENT_COUNT],
    pub ts_ms:             i64,
}

// ── SHM Bridge ───────────────────────────────────────────────────────────────

pub struct ShmBridge {
    mmap: MmapMut,
}

unsafe impl Send for ShmBridge {}
unsafe impl Sync for ShmBridge {}

impl ShmBridge {
    /// Open an existing SHM segment created by Go.
    /// Panics if the segment doesn't exist yet.
    pub fn open() -> anyhow::Result<Self> {
        let name = std::ffi::CString::new(SHM_NAME)?;
        let fd = unsafe { shm_open(name.as_ptr(), O_RDWR, 0o600) };
        if fd < 0 {
            anyhow::bail!(
                "shm_open({SHM_NAME}) failed: {}. Is the Go gateway running?",
                std::io::Error::last_os_error()
            );
        }
        // SAFETY: fd is valid, we map exactly SHM_SIZE bytes
        let mmap = unsafe { MmapMut::map_mut(fd)? };
        if mmap.len() < SHM_SIZE {
            anyhow::bail!("SHM region too small: {} < {SHM_SIZE}", mmap.len());
        }
        unsafe { libc::close(fd) };
        log::info!("[SHM] Mapped {SHM_NAME} ({SHM_SIZE} bytes)");
        Ok(Self { mmap })
    }

    // ── Low-level atomic helpers ─────────────────────────────────────────────

    #[inline]
    fn read_u32(&self, offset: usize) -> u32 {
        let ptr = unsafe { self.mmap.as_ptr().add(offset) as *const u32 };
        unsafe { std::ptr::read_volatile(ptr) }
    }

    #[inline]
    fn read_u64(&self, offset: usize) -> u64 {
        let ptr = unsafe { self.mmap.as_ptr().add(offset) as *const u64 };
        unsafe { std::ptr::read_volatile(ptr) }
    }

    #[inline]
    fn write_u32(&mut self, offset: usize, val: u32) {
        let ptr = unsafe { self.mmap.as_mut_ptr().add(offset) as *mut u32 };
        unsafe { std::ptr::write_volatile(ptr, val) };
    }

    #[inline]
    fn write_u64(&mut self, offset: usize, val: u64) {
        let ptr = unsafe { self.mmap.as_mut_ptr().add(offset) as *mut u64 };
        unsafe { std::ptr::write_volatile(ptr, val) };
    }

    #[inline]
    fn read_f64_at(&self, offset: usize) -> f64 {
        let ptr = unsafe { self.mmap.as_ptr().add(offset) as *const f64 };
        unsafe { std::ptr::read_volatile(ptr) }
    }

    // ── Protocol: wait for fresh MarketData ─────────────────────────────────

    /// Block until Go writes a fresh MarketData snapshot, then return it.
    /// Uses seqlock to guarantee consistency: if Go writes during our read,
    /// we retry automatically.
    pub fn wait_for_market(&self, timeout: Duration) -> Option<MarketSnapshot> {
        let deadline = Instant::now() + timeout;
        let mut spins: u64 = 0;

        loop {
            if Instant::now() > deadline { return None; }

            let ready = self.read_u32(OFF_DREADY);
            if ready != 1 {
                spins += 1;
                if spins > 10_000 {
                    std::thread::sleep(Duration::from_micros(100));
                } else {
                    std::hint::spin_loop();
                }
                continue;
            }

            // Seqlock: read go_seq before and after
            let seq_before = self.read_u64(OFF_GO_SEQ);
            if seq_before & 1 != 0 {
                // Write in progress — spin
                std::hint::spin_loop();
                continue;
            }

            fence(Ordering::Acquire);

            let snapshot = self.parse_market_snapshot();

            fence(Ordering::Acquire);
            let seq_after = self.read_u64(OFF_GO_SEQ);

            if seq_after != seq_before {
                // Data changed during read — retry
                continue;
            }

            // Consume the ready flag
            // SAFETY: single reader (Rust) — no race with Go which only sets, never clears
            unsafe {
                std::ptr::write_volatile(
                    self.mmap.as_ptr().add(OFF_DREADY) as *mut u32,
                    0u32,
                );
            }
            fence(Ordering::Release);

            return Some(snapshot);
        }
    }

    fn parse_market_snapshot(&self) -> MarketSnapshot {
        let base = OFF_MARKET;
        let raw  = self.mmap.as_ptr();

        // SAFETY: all offsets derived from fixed layout matching shm_types.h
        unsafe {
            let sym_ptr = raw.add(base) as *const [u8; SYM_LEN];
            let symbol  = *sym_ptr;

            let candles_base = base + SYM_LEN;                // +16
            let n_candles    = std::ptr::read_volatile(
                raw.add(candles_base + MAX_CANDLES * 48) as *const u32  // n_candles after array
            ) as usize;
            let n_candles    = n_candles.min(MAX_CANDLES);

            let mut candles = Vec::with_capacity(n_candles);
            for i in 0..n_candles {
                let off = candles_base + i * 48;
                let c = Candle {
                    open:  f64::from_le_bytes(*raw.add(off    ).cast::<[u8;8]>()),
                    high:  f64::from_le_bytes(*raw.add(off+8  ).cast::<[u8;8]>()),
                    low:   f64::from_le_bytes(*raw.add(off+16 ).cast::<[u8;8]>()),
                    close: f64::from_le_bytes(*raw.add(off+24 ).cast::<[u8;8]>()),
                    vol:   f64::from_le_bytes(*raw.add(off+32 ).cast::<[u8;8]>()),
                    ts_ms: i64::from_le_bytes(*raw.add(off+40 ).cast::<[u8;8]>()),
                };
                candles.push(c);
            }

            // Scalar fields start after: symbol(16) + candles(200*48=9600) + n_candles(4) + pad(4)
            let sf = base + 16 + MAX_CANDLES * 48 + 4 + 4;

            MarketSnapshot {
                symbol,
                candles,
                price:            f64::from_le_bytes(*raw.add(sf     ).cast::<[u8;8]>()),
                bid:              f64::from_le_bytes(*raw.add(sf+8   ).cast::<[u8;8]>()),
                ask:              f64::from_le_bytes(*raw.add(sf+16  ).cast::<[u8;8]>()),
                oi:               f64::from_le_bytes(*raw.add(sf+24  ).cast::<[u8;8]>()),
                lsr:              f64::from_le_bytes(*raw.add(sf+32  ).cast::<[u8;8]>()),
                atr_14:           f64::from_le_bytes(*raw.add(sf+40  ).cast::<[u8;8]>()),
                funding_rate:     f64::from_le_bytes(*raw.add(sf+48  ).cast::<[u8;8]>()),
                usdt_delta_pct:   f64::from_le_bytes(*raw.add(sf+56  ).cast::<[u8;8]>()),
                kimchi_pct:       f64::from_le_bytes(*raw.add(sf+64  ).cast::<[u8;8]>()),
                whale_inflow_usd: f64::from_le_bytes(*raw.add(sf+72  ).cast::<[u8;8]>()),
                long_liq_1h:      f64::from_le_bytes(*raw.add(sf+80  ).cast::<[u8;8]>()),
                short_liq_1h:     f64::from_le_bytes(*raw.add(sf+88  ).cast::<[u8;8]>()),
                sentiment_score:  f32::from_le_bytes(*raw.add(sf+96  ).cast::<[u8;4]>()),
                news_count:       u32::from_le_bytes(*raw.add(sf+100 ).cast::<[u8;4]>()),
                ts_ms:            i64::from_le_bytes(*raw.add(sf+104 ).cast::<[u8;8]>()),
            }
        }
    }

    /// Write SignalOutput to SHM and notify Go via signal_ready flag.
    pub fn write_signal(&mut self, sig: &SignalOutput) {
        // Fixed offset for SignalResult — Go calculates the same
        // sizeof(ShmCtrl=64) + sizeof(MarketData) — we hardcode based on layout
        const OFF_SIGNAL: usize = 64
            + SYM_LEN                  // 16
            + MAX_CANDLES * 48         // 9600
            + 4 + 4                    // n_candles + pad
            + 13 * 8                   // 13 f64 scalars
            + 4 + 4 + 8;               // sentiment(f32) + news_count(u32) + ts_ms(i64)

        let raw = unsafe { self.mmap.as_mut_ptr().add(OFF_SIGNAL) };

        // Encode veto_reason into fixed buffer
        let mut reason_buf = [0u8; REASON_LEN];
        let bytes = sig.veto_reason.as_bytes();
        let len   = bytes.len().min(REASON_LEN - 1);
        reason_buf[..len].copy_from_slice(&bytes[..len]);

        // Write all fields
        unsafe {
            let mut off = 0usize;
            raw.add(off).write_volatile(sig.action as u8); off += 1;
            raw.add(off).write_volatile(sig.veto as u8);   off += 1;
            // 6 bytes pad
            off += 6;
            // 8-byte align now
            (raw.add(off) as *mut f64).write_volatile(sig.confidence);   off += 8;
            (raw.add(off) as *mut f64).write_volatile(sig.entry);        off += 8;
            (raw.add(off) as *mut f64).write_volatile(sig.take_profit);  off += 8;
            (raw.add(off) as *mut f64).write_volatile(sig.stop_loss);    off += 8;
            (raw.add(off) as *mut f64).write_volatile(sig.risk_reward);  off += 8;
            std::ptr::copy_nonoverlapping(reason_buf.as_ptr(), raw.add(off), REASON_LEN); off += REASON_LEN;
            std::ptr::copy_nonoverlapping(sig.agent_dirs.as_ptr(), raw.add(off), AGENT_COUNT); off += AGENT_COUNT;
            off += 2; // pad
            for (i, &c) in sig.agent_convictions.iter().enumerate() {
                (raw.add(off + i*8) as *mut f64).write_volatile(c);
            }
            off += AGENT_COUNT * 8;
            (raw.add(off) as *mut i64).write_volatile(sig.ts_ms);
        }

        fence(Ordering::SeqCst);

        // Notify Go
        self.write_u32(OFF_SREADY, 1);
        let old_seq = self.read_u64(OFF_RS_SEQ);
        self.write_u64(OFF_RS_SEQ, old_seq + 1);

        log::debug!(
            "[SHM] Signal written: {:?} conf={:.3} entry={:.4} TP={:.4} SL={:.4}",
            sig.action, sig.confidence, sig.entry, sig.take_profit, sig.stop_loss
        );
    }
}
