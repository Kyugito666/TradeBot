// go_engine/mmap_manager.go
//
// Manages the shared memory IPC channel between the Go data/execution engine
// and the Rust analysis engine. Uses a seqlock for wait-free, torn-read-safe
// multi-field updates across process boundaries.
//
// Single-writer (Go): calls Write() when new market data arrives from WebSocket.
// Single-writer (Rust): calls the equivalent seqlock write for the signal field.
// Multi-reader: both sides can call Read() concurrently with zero locks.

package main

import (
	"fmt"
	"math"
	"os"
	"sync/atomic"
	"syscall"
	"unsafe"
)

// ── IPC Contract ────────────────────────────────────────────────────────────

const (
	// ShmPath MUST be /dev/shm/ — guaranteed tmpfs (RAM), zero disk I/O.
	// /tmp is NOT acceptable for HFT latency requirements.
	ShmPath = "/dev/shm/quant_shared.mem"

	// ShmSize is exactly one CPU cache line (64 bytes).
	// This prevents false sharing and ensures the entire frame is fetched
	// in a single cache coherency transaction.
	ShmSize = 64
)

// Execution signal constants. Written by Rust, consumed by Go executor.
// Use uint32 (not uint8/int8) to guarantee atomic load/store on all Go targets.
const (
	SignalHold  uint32 = 0
	SignalLong  uint32 = 1
	SignalShort uint32 = 2
)

// ── Shared Memory Frame ─────────────────────────────────────────────────────

// SharedFrame is the canonical byte layout of the IPC memory region.
// It MUST be byte-for-byte identical to the Rust struct definition in
// rust_engine/src/mmap_reader.rs.
//
// Field offsets (verified against Go struct padding rules for amd64):
//   seq      │ offset  0 │ size 8 │ align 8
//   price    │ offset  8 │ size 8 │ align 8
//   funding  │ offset 16 │ size 8 │ align 8
//   liqMag   │ offset 24 │ size 8 │ align 8
//   signal   │ offset 32 │ size 4 │ align 4
//   _pad     │ offset 36 │ size 28│ align 1
//   TOTAL    │           │ 64     │
//
// WARNING: Never add fields between existing ones. Rust's repr(C) and Go's
// layout MUST remain in sync. Any change requires a coordinated update in
// both engines + a version bump in the seqlock header (future enhancement).
type SharedFrame struct {
	// seq is the seqlock counter.
	// Even value  = frame is in a stable, readable state.
	// Odd value   = a write is in progress; readers must spin.
	// Invariant: seq is ONLY incremented by the designated writer process.
	seq uint64

	// price, funding, liqMag store float64 values as their raw IEEE 754 bit
	// patterns. We use uint64 fields so we can operate on them with
	// sync/atomic, which only has typed ops for integer types in Go < 1.19.
	// Use math.Float64bits / math.Float64frombits to convert.
	price   uint64
	funding uint64
	liqMag  uint64

	// signal is the execution directive from the Rust analyzer.
	// uint32 ensures 4-byte alignment, which is atomically accessible on
	// all Go target architectures (including ARM32 where uint64 needs 8-byte
	// alignment that isn't always guaranteed by the ABI).
	signal uint32

	// _pad fills the struct to exactly 64 bytes (one cache line).
	// This prevents false sharing: adjacent memory variables in either process
	// do not share a cache line with this frame, eliminating coherency traffic.
	_pad [28]byte
}

// ── Manager ─────────────────────────────────────────────────────────────────

// MmapManager owns the file descriptor and the mapped memory region.
// It exposes a zero-allocation read/write API for use in the hot trading loop.
//
// Lifecycle:
//   1. Call NewMmapManager(true)  in the Go process (creator/writer).
//   2. Call NewMmapManager(false) in the Rust process (reader) — or use the
//      Rust equivalent in mmap_reader.rs.
//   3. Call Close() on both sides during graceful shutdown.
type MmapManager struct {
	f     *os.File
	data  []byte
	frame *SharedFrame // Direct pointer into mmap region. Zero-copy, zero-alloc.
}

// NewMmapManager opens (create=true) or attaches (create=false) to the shared
// memory segment and maps it into the process address space.
//
// create=true  → Go engine: creates the file, truncates to ShmSize, maps R/W.
// create=false → Rust engine (via Go test harness): attaches to existing file.
//
// This function allocates. Call it ONCE at startup, not in the trading loop.
func NewMmapManager(create bool) (*MmapManager, error) {
	flags := os.O_RDWR
	if create {
		flags |= os.O_CREATE | os.O_TRUNC
	}

	f, err := os.OpenFile(ShmPath, flags, 0600)
	if err != nil {
		return nil, fmt.Errorf("mmap_manager: open %q: %w", ShmPath, err)
	}

	if create {
		// Truncate to exact size BEFORE mapping. Accessing a mapped region
		// beyond the file's actual size causes SIGBUS — a silent data corruption
		// that's harder to debug than a startup panic.
		if err := f.Truncate(ShmSize); err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("mmap_manager: truncate to %d bytes: %w", ShmSize, err)
		}
	}

	// MAP_SHARED: writes to the mapped region are visible to all processes
	// that have mapped the same file. This is the core IPC mechanism.
	// MAP_POPULATE (Linux-specific) would pre-fault the pages to avoid a
	// page fault on first access — acceptable here since it's startup code.
	data, err := syscall.Mmap(
		int(f.Fd()),
		0,        // offset: start of file
		ShmSize,
		syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_SHARED,
	)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("mmap_manager: syscall.Mmap: %w", err)
	}

	// Verify 8-byte alignment of the mapped base address.
	// mmap() guarantees page alignment (typically 4096 bytes), so this check
	// should never fail. It's here to make the alignment contract explicit and
	// to catch hypothetical future regressions in the mapping code.
	baseAddr := uintptr(unsafe.Pointer(&data[0]))
	if baseAddr%8 != 0 {
		_ = syscall.Munmap(data)
		_ = f.Close()
		return nil, fmt.Errorf(
			"mmap_manager: region base address 0x%x is not 8-byte aligned — "+
				"atomic uint64 operations would be undefined behavior",
			baseAddr,
		)
	}

	// Cast the raw []byte backing array to *SharedFrame.
	//
	// This is the ONE place in this file that uses unsafe.Pointer.
	// Safety justification:
	//   1. data[0] is 8-byte aligned (verified above).
	//   2. len(data) == ShmSize == sizeof(SharedFrame) == 64 bytes.
	//   3. The mmap region's lifetime is tied to MmapManager.Close().
	//   4. We never allow the []byte slice to be GC'd while frame is in use
	//      (both are owned by the same MmapManager struct).
	//   5. All subsequent field access goes through sync/atomic, which
	//      provides the necessary memory ordering guarantees.
	frame := (*SharedFrame)(unsafe.Pointer(&data[0]))

	return &MmapManager{
		f:     f,
		data:  data,
		frame: frame,
	}, nil
}

// Close releases the memory mapping and closes the file descriptor.
// After Close(), all pointers derived from frame are invalid.
// Must be called exactly once during graceful shutdown.
func (m *MmapManager) Close() error {
	if err := syscall.Munmap(m.data); err != nil {
		return fmt.Errorf("mmap_manager: munmap: %w", err)
	}
	if err := m.f.Close(); err != nil {
		return fmt.Errorf("mmap_manager: close fd: %w", err)
	}
	return nil
}

// ── Writer API ───────────────────────────────────────────────────────────────

// Write publishes a complete market snapshot atomically using a seqlock.
//
// SEQLOCK WRITE PROTOCOL:
//   Phase 1 (lock):   Increment seq from even N to odd N+1.
//                     Readers seeing an odd seq know a write is in progress
//                     and will spin rather than consuming partial data.
//   Phase 2 (write):  Store each field with atomic.Store to ensure the Go
//                     memory model provides the required visibility guarantees.
//                     On x86-64, these compile to plain MOV instructions
//                     (TSO makes stores sequentially consistent by default),
//                     but on ARM/POWER the compiler emits the necessary fences.
//   Phase 3 (unlock): Increment seq from odd N+1 to even N+2.
//                     Readers seeing the same even seq before and after their
//                     load sequence know the data is consistent.
//
// CONCURRENCY CONTRACT:
//   - Write() must be called by EXACTLY ONE goroutine at a time.
//   - The caller is responsible for external serialization if multiple
//     goroutines produce market data (e.g., wrap with sync.Mutex upstream).
//   - Read() and ReadSignal() may be called concurrently by any number of
//     goroutines with no additional synchronization.
//
// ALLOCATION: NONE. This function is safe for use in the hot trading loop.
func (m *MmapManager) Write(price, funding, liqMag float64, signal uint32) {
	f := m.frame

	// Phase 1: Begin write — transition seq to odd.
	// LoadUint64 + StoreUint64 is NOT a CAS; it's safe here because
	// Write() is single-writer by contract. We load the current (even) value
	// so we can increment it by 1 (to odd) and then by 1 again (to even+2),
	// rather than doing a blind increment that could overflow unexpectedly
	// after 2^63 writes (non-issue in practice, but semantically cleaner).
	seq := atomic.LoadUint64(&f.seq)
	atomic.StoreUint64(&f.seq, seq+1)

	// Phase 2: Write data fields.
	// math.Float64bits performs a bitwise reinterpretation with zero alloc.
	// The resulting uint64 is then stored atomically, ensuring cross-process
	// visibility per the Go memory model.
	atomic.StoreUint64(&f.price, math.Float64bits(price))
	atomic.StoreUint64(&f.funding, math.Float64bits(funding))
	atomic.StoreUint64(&f.liqMag, math.Float64bits(liqMag))
	atomic.StoreUint32(&f.signal, signal)

	// Phase 3: End write — transition seq to even (next stable value).
	atomic.StoreUint64(&f.seq, seq+2)
}

// WriteSignalOnly updates only the execution signal without the overhead of a
// full seqlock write cycle.
//
// Use case: The Rust analyzer has written a Long/Short signal into the frame.
// After the Go executor has consumed and acted on it, it calls
// WriteSignalOnly(SignalHold) to reset the signal. Since signal is a single
// uint32 field, a single atomic store is sufficient for correctness.
//
// ALLOCATION: NONE.
func (m *MmapManager) WriteSignalOnly(signal uint32) {
	atomic.StoreUint32(&m.frame.signal, signal)
}

// ── Reader API ───────────────────────────────────────────────────────────────

// Snapshot holds the decoded, Go-native values from a single consistent read
// of the shared frame. Returned by value to avoid heap allocation.
type Snapshot struct {
	Price   float64
	Funding float64
	LiqMag  float64
	Signal  uint32
}

// Read performs a seqlock read and returns a consistent Snapshot.
//
// SEQLOCK READ PROTOCOL:
//   1. Load seq. If odd, spin (writer is active). If even, proceed.
//   2. Load all data fields with atomic.Load.
//   3. Load seq again.
//   4. If seq1 == seq2, the read was consistent — return the snapshot.
//      If seq1 != seq2, a write completed during our read — retry from step 1.
//
// PERFORMANCE CHARACTERISTICS:
//   - Zero allocations: Snapshot is returned by value on the stack.
//   - Wait-free for the writer: Write() is never blocked by Read().
//   - Lock-free for readers: Read() is never blocked by other Read() calls.
//   - On a quiescent market (writes are infrequent), Read() completes in
//     a single pass (two atomic loads of seq + four data loads).
//   - On a hot market (continuous writes at ~100µs intervals), the spin
//     loop runs for at most a few nanoseconds (the duration of Write()).
//
// ALLOCATION: NONE. Safe for the hot trading loop.
func (m *MmapManager) Read() Snapshot {
	f := m.frame

	for {
		// Step 1: Load seq — spin if odd (write in progress).
		seq1 := atomic.LoadUint64(&f.seq)
		if seq1&1 != 0 {
			// Tight spin: Write() holds the "lock" for ~5 atomic stores (~10ns
			// on modern hardware). A PAUSE instruction (via runtime.Gosched()
			// is too coarse; an assembly PAUSE would be ideal here but requires
			// a CGO/asm shim). The tight loop is acceptable given the spin
			// duration is bounded by the Write() critical section length.
			continue
		}

		// Step 2: Read all data fields under the assumed-stable seq.
		priceBits   := atomic.LoadUint64(&f.price)
		fundingBits := atomic.LoadUint64(&f.funding)
		liqMagBits  := atomic.LoadUint64(&f.liqMag)
		sig         := atomic.LoadUint32(&f.signal)

		// Step 3: Validate that seq hasn't changed since step 1.
		seq2 := atomic.LoadUint64(&f.seq)
		if seq1 == seq2 {
			// Consistent read confirmed. Decode and return.
			return Snapshot{
				Price:   math.Float64frombits(priceBits),
				Funding: math.Float64frombits(fundingBits),
				LiqMag:  math.Float64frombits(liqMagBits),
				Signal:  sig,
			}
		}
		// seq changed — a write occurred mid-read. Retry.
		// This branch is taken at most once per Write() call that overlaps
		// with this Read() call. Expected retry count per call: < 0.001.
	}
}

// ReadSignal performs a single atomic load of the signal field.
//
// This is the hot-path read for the execution engine: it only cares about
// WHETHER there's an actionable signal, not about price/funding data (which
// comes from the WebSocket feed directly). No seqlock needed — a single
// uint32 is atomically readable on all supported architectures.
//
// ALLOCATION: NONE. Designed for sub-100ns call overhead.
func (m *MmapManager) ReadSignal() uint32 {
	return atomic.LoadUint32(&m.frame.signal)
}

// ── Diagnostic API (not used in hot path) ───────────────────────────────────

// DebugSnapshot returns a Snapshot along with the raw sequence counter.
// Use only in logging/monitoring code, never in the trading loop.
func (m *MmapManager) DebugSnapshot() (Snapshot, uint64) {
	s := m.Read()
	seq := atomic.LoadUint64(&m.frame.seq)
	return s, seq
}
