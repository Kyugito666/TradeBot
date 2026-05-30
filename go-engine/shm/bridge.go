// go-engine/shm/bridge.go
//
// POSIX Shared Memory bridge — Go side.
// Mirrors the C-ABI layout defined in shared/shm_types.h EXACTLY.
// No CGO required: we open /dev/shm/tradebot_v3 as a regular file
// and mmap it, which is semantically identical to shm_open on Linux.
//
// Layout (byte offsets):
//   [0..63]    ShmCtrl  (go_seq u64, rust_seq u64, data_ready u32, signal_ready u32, pad[40])
//   [64..9799] MarketData
//   [9800..]   SignalResult
//
// Seqlock write protocol (Go → Rust):
//   1. go_seq++ (make odd → "write in progress")
//   2. fence / atomic store
//   3. Write all MarketData fields
//   4. fence
//   5. go_seq++ (make even → "write complete")
//   6. data_ready = 1

package shm

import (
	"encoding/binary"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// ── Byte offsets matching shm_types.h ────────────────────────────────────────

const (
	ShmName = "/tradebot_v3"
	ShmSize = 131_072 // 128 KiB

	// ShmCtrl offsets
	offGoSeq      = 0
	offRustSeq    = 8
	offDataReady  = 16
	offSigReady   = 20
	// pad [24..63]

	// MarketData layout
	offMarket   = 64
	maxCandles  = 200
	candleBytes = 48 // 6 × float64/int64
	symLen      = 16
	agentCount  = 9
	reasonLen   = 256

	offSymbol   = offMarket
	offCandles  = offSymbol + symLen   // 80
	offNCandles = offCandles + maxCandles*candleBytes // 80+9600 = 9680
	offPad1     = offNCandles + 4                     // 9684
	offPrice    = offPad1 + 4                         // 9688 (8-byte aligned)
	offBid      = offPrice + 8                        // 9696
	offAsk      = offBid + 8                          // 9704
	offOI       = offAsk + 8                          // 9712
	offLSR      = offOI + 8                           // 9720
	offATR14    = offLSR + 8                          // 9728
	offFunding  = offATR14 + 8                        // 9736
	offUSDTD    = offFunding + 8                      // 9744
	offKimchi   = offUSDTD + 8                        // 9752
	offWhaleIn  = offKimchi + 8                       // 9760
	offLongLiq  = offWhaleIn + 8                      // 9768
	offShortLiq = offLongLiq + 8                      // 9776
	offSentF32  = offShortLiq + 8                     // 9784
	offNewsCnt  = offSentF32 + 4                      // 9788
	offMktTs    = offNewsCnt + 4                      // 9792 (8-byte aligned)
	// MarketData ends at 9800

	// SignalResult layout (offset 9800)
	offSig          = 9800
	offSigAction    = offSig + 0  // uint8
	offSigVeto      = offSig + 1  // uint8
	// _pad2 [9802..9808]
	offSigConf      = offSig + 8   // float64
	offSigEntry     = offSig + 16
	offSigTP        = offSig + 24
	offSigSL        = offSig + 32
	offSigRR        = offSig + 40
	offSigReason    = offSig + 48             // [256]byte
	offSigDirs      = offSigReason + reasonLen // [9]uint8
	// alignment padding for 8 bytes: 10104 + 9 = 10113 -> pad 7 bytes = 10120
	offSigConvBase  = offSigDirs + agentCount + 7 // [9]float64
	offSigTs        = offSigConvBase + agentCount*8
)

// Direction mirrors rust's Direction enum
type Direction uint8

const (
	DirWait Direction = 0
	DirBuy  Direction = 1
	DirSell Direction = 2
)

// Candle is a single OHLCV bar passed to Rust
type Candle struct {
	Open, High, Low, Close, Volume float64
	TsMs                           int64
}

// MarketData is the full snapshot written by Go into SHM each loop tick
type MarketData struct {
	Symbol         [symLen]byte
	Candles        []Candle // max 200
	Price, Bid, Ask float64
	OI, LSR         float64
	ATR14           float64
	FundingRate     float64
	USDTDeltaPct    float64
	KimchiPct       float64
	WhaleInflowUSD  float64
	LongLiq1h       float64
	ShortLiq1h      float64
	SentimentScore  float32
	NewsCount       uint32
	TsMs            int64
}

// Signal is the consensus output read from SHM (written by Rust)
type Signal struct {
	Action          Direction
	Veto            bool
	Confidence      float64
	Entry           float64
	TakeProfit      float64
	StopLoss        float64
	RiskReward      float64
	VetoReason      string
	AgentDirs       [agentCount]uint8
	AgentConvictions [agentCount]float64
	TsMs            int64
}

// ── Bridge ────────────────────────────────────────────────────────────────────

// Bridge owns the mmap'd region and provides thread-safe read/write methods
type Bridge struct {
	mu   sync.Mutex
	data []byte
	f    *os.File
}

// Open creates (or reopens) the SHM file and maps it into the process address space
func Open() (*Bridge, error) {
	path := filepath.Join("/dev/shm", ShmName[1:]) // strip leading /

	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}

	if err := f.Truncate(ShmSize); err != nil {
		f.Close()
		return nil, err
	}

	data, err := syscall.Mmap(
		int(f.Fd()),
		0,
		ShmSize,
		syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_SHARED,
	)
	if err != nil {
		f.Close()
		return nil, err
	}

	b := &Bridge{data: data, f: f}
	// Zero out control block on fresh start
	for i := 0; i < 64; i++ {
		b.data[i] = 0
	}
	return b, nil
}

// Close unmaps and closes the SHM file
func (b *Bridge) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := syscall.Munmap(b.data); err != nil {
		return err
	}
	return b.f.Close()
}

// ── Seqlock helpers ───────────────────────────────────────────────────────────

func (b *Bridge) readU32(off int) uint32 {
	p := (*uint32)(unsafe.Pointer(&b.data[off]))
	return atomic.LoadUint32(p)
}

func (b *Bridge) writeU32(off int, v uint32) {
	p := (*uint32)(unsafe.Pointer(&b.data[off]))
	atomic.StoreUint32(p, v)
}

func (b *Bridge) readU64(off int) uint64 {
	p := (*uint64)(unsafe.Pointer(&b.data[off]))
	return atomic.LoadUint64(p)
}

func (b *Bridge) writeU64(off int, v uint64) {
	p := (*uint64)(unsafe.Pointer(&b.data[off]))
	atomic.StoreUint64(p, v)
}

func putF64(buf []byte, off int, v float64) {
	binary.LittleEndian.PutUint64(buf[off:], math.Float64bits(v))
}

func putF32(buf []byte, off int, v float32) {
	binary.LittleEndian.PutUint32(buf[off:], math.Float32bits(v))
}

func getF64(buf []byte, off int) float64 {
	return math.Float64frombits(binary.LittleEndian.Uint64(buf[off:]))
}

func getF32(buf []byte, off int) float32 {
	return math.Float32frombits(binary.LittleEndian.Uint32(buf[off:]))
}

// ── WriteMarketData ───────────────────────────────────────────────────────────

// WriteMarket serialises md into SHM using the seqlock write protocol.
// Safe to call from a single goroutine; locking ensures no two goroutines
// clobber each other even if the caller forgets.
func (b *Bridge) WriteMarket(md *MarketData) {
	b.mu.Lock()
	defer b.mu.Unlock()

	// Seqlock: make go_seq odd ("write started")
	seq := b.readU64(offGoSeq)
	b.writeU64(offGoSeq, seq+1)
	// Full memory barrier (Go's atomic store provides sequential consistency)
	_ = atomic.LoadUint64((*uint64)(unsafe.Pointer(&b.data[offGoSeq])))

	d := b.data

	// ── Symbol ────────────────────────────────────────────────────────────
	for i := 0; i < symLen; i++ {
		if i < len(md.Symbol) {
			d[offSymbol+i] = md.Symbol[i]
		} else {
			d[offSymbol+i] = 0
		}
	}

	// ── Candles ───────────────────────────────────────────────────────────
	n := len(md.Candles)
	if n > maxCandles {
		n = maxCandles
	}
	for i := 0; i < n; i++ {
		base := offCandles + i*candleBytes
		c := md.Candles[i]
		putF64(d, base+0,  c.Open)
		putF64(d, base+8,  c.High)
		putF64(d, base+16, c.Low)
		putF64(d, base+24, c.Close)
		putF64(d, base+32, c.Volume)
		binary.LittleEndian.PutUint64(d[base+40:], uint64(c.TsMs))
	}
	// n_candles field
	binary.LittleEndian.PutUint32(d[offNCandles:], uint32(n))
	// _pad1 (already zeroed)

	// ── Scalars ───────────────────────────────────────────────────────────
	putF64(d, offPrice,    md.Price)
	putF64(d, offBid,      md.Bid)
	putF64(d, offAsk,      md.Ask)
	putF64(d, offOI,       md.OI)
	putF64(d, offLSR,      md.LSR)
	putF64(d, offATR14,    md.ATR14)
	putF64(d, offFunding,  md.FundingRate)
	putF64(d, offUSDTD,    md.USDTDeltaPct)
	putF64(d, offKimchi,   md.KimchiPct)
	putF64(d, offWhaleIn,  md.WhaleInflowUSD)
	putF64(d, offLongLiq,  md.LongLiq1h)
	putF64(d, offShortLiq, md.ShortLiq1h)
	putF32(d, offSentF32,  md.SentimentScore)
	binary.LittleEndian.PutUint32(d[offNewsCnt:], md.NewsCount)
	binary.LittleEndian.PutUint64(d[offMktTs:],   uint64(md.TsMs))

	// Seqlock: make go_seq even ("write complete")
	b.writeU64(offGoSeq, seq+2)
	// Signal Rust
	b.writeU32(offDataReady, 1)
}

// ── ReadSignal ────────────────────────────────────────────────────────────────

// PollSignal returns the SignalResult if signal_ready == 1, otherwise nil.
// Caller should poll in a tight loop (or with a short sleep) after writing market data.
func (b *Bridge) PollSignal(timeout time.Duration) *Signal {
	deadline := time.Now().Add(timeout)
	for {
		ready := b.readU32(offSigReady)
		if ready == 1 {
			sig := b.readSignal()
			b.writeU32(offSigReady, 0) // Consume
			return sig
		}
		if time.Now().After(deadline) {
			return nil
		}
		time.Sleep(50 * time.Microsecond) // ~20k polls/sec max
	}
}

func (b *Bridge) readSignal() *Signal {
	d := b.data
	sig := &Signal{}
	sig.Action    = Direction(d[offSigAction])
	sig.Veto      = d[offSigVeto] != 0
	sig.Confidence = getF64(d, offSigConf)
	sig.Entry      = getF64(d, offSigEntry)
	sig.TakeProfit = getF64(d, offSigTP)
	sig.StopLoss   = getF64(d, offSigSL)
	sig.RiskReward = getF64(d, offSigRR)

	raw := d[offSigReason : offSigReason+reasonLen]
	end := 0
	for end < len(raw) && raw[end] != 0 {
		end++
	}
	sig.VetoReason = string(raw[:end])

	for i := 0; i < agentCount; i++ {
		sig.AgentDirs[i] = d[offSigDirs+i]
		sig.AgentConvictions[i] = getF64(d, offSigConvBase+i*8)
	}
	sig.TsMs = int64(binary.LittleEndian.Uint64(d[offSigTs:]))
	return sig
}

// RustSeq returns Rust's sequence counter (monotonically increasing with each signal write)
func (b *Bridge) RustSeq() uint64 {
	return b.readU64(offRustSeq)
}
