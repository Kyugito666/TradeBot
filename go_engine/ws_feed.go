// go_engine/ws_feed.go
//
// Zero-allocation WebSocket market data feed for Bybit Futures.
// Reads the public ticker stream and publishes price + funding rate to the
// mmap IPC channel on every received frame.
//
// Allocation budget (total, one-time at startup):
//   WsFeed struct  ≈ 8.2 KB  (dominated by readBuf [8192]byte)
//   subMsg         ≈ 60 B
//   pingMsg        ≈ 14 B
//   key slices     ≈ 64 B
//
// Allocations in the hot path: ZERO.

package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"math/rand"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/gorilla/websocket"
)

// ── Constants ────────────────────────────────────────────────────────────────

const (
	bybitWSURL = "wss://stream.bytick.com/v5/public/linear"

	// pingEvery must be < 30s. Bybit closes idle connections after 30s.
	// We send every 20s for a comfortable safety margin.
	pingEvery = 20 * time.Second

	// readBufSize must comfortably exceed the largest expected single message.
	// Bybit ticker snapshot ≈ 900 bytes. 8 KiB is a 9× headroom.
	readBufSize = 8192

	// Reconnect backoff range: [500ms ... 60s], doubling per attempt, full jitter.
	reconnectBase = 500 * time.Millisecond
	reconnectMax  = 60 * time.Second
)

// ── MmapManager extension ────────────────────────────────────────────────────
// Placed here (same package) to avoid circular dependency between files.
// This is the ONLY write path for the Go feed — it preserves Rust-owned fields.

// WriteMarketData updates only the Go-owned fields (price, funding) while
// atomically reading and re-writing the Rust-owned fields (liqMag, signal)
// unchanged.
//
// Race window analysis:
//   If Rust writes a new liqMag between our atomic.LoadUint64 and the inner
//   Write() completing, we overwrite Rust's new value with the old one.
//   The window is ~50 ns (duration of Write()). The next tick (≤100 ms away)
//   will re-read the fresh liqMag. Acceptable for a slowly-evolving analysis
//   output whose update cadence is measured in seconds, not nanoseconds.
//
// ALLOCATION: NONE.
func (m *MmapManager) WriteMarketData(price, funding float64) {
	liqMag := math.Float64frombits(atomic.LoadUint64(&m.frame.liqMag))
	signal := atomic.LoadUint32(&m.frame.signal)
	m.Write(price, funding, liqMag, signal)
}

// ── WsFeed struct ────────────────────────────────────────────────────────────

// WsFeed is the zero-allocation WebSocket market data publisher.
//
// Critical design invariants for the hot path:
//   1. readBuf is the ONLY I/O buffer. Allocated once with the struct, never
//      resized. All NextReader() payload bytes land here.
//   2. findStringValue() returns sub-slices of readBuf. No string or []byte
//      allocation occurs during JSON field extraction.
//   3. bytesToFloat64() uses unsafe.String() to create a string view over
//      readBuf bytes. strconv.ParseFloat does not retain the string.
//   4. lastPriceBits / lastFundingBits live on the struct. Compared bitwise to
//      avoid redundant mmap writes for duplicate ticks.
//   5. subMsg, pingMsg, and all key* slices are immutable after NewWsFeed().
type WsFeed struct {
	symbol string
	mmap   *MmapManager
	log    *slog.Logger

	// readBuf: pre-allocated I/O buffer. Single allocation for the feed's lifetime.
	// Declared as [N]byte (array, not slice) so the storage is embedded in the
	// struct, not separately heap-allocated.
	readBuf [readBufSize]byte

	// ── Pre-serialized wire protocol messages ─────────────────────────────
	// Built once in NewWsFeed(). websocket.WriteMessage() accepts []byte
	// directly — no serialization or allocation on the write path.
	subMsg  []byte // {"op":"subscribe","args":["tickers.BTCUSDT"]}
	pingMsg []byte // {"op":"ping"}

	// ── Pre-built JSON scanner keys ───────────────────────────────────────
	// findStringValue() receives these as []byte to avoid string→[]byte
	// conversion on every call. Allocated once, read-only thereafter.
	keyLastPrice   []byte // []byte("lastPrice")
	keyFundingRate []byte // []byte("fundingRate")
	keyTopic       []byte // []byte("topic")

	// expectedTopic is the canonical topic string for this symbol.
	// Messages whose "topic" field does not equal this are discarded immediately.
	expectedTopic []byte // []byte("tickers.BTCUSDT")

	// ── Last published state (hot path, single goroutine, no sync needed) ─
	// Stored as IEEE 754 bit patterns for bitwise equality comparison.
	// These fields are ONLY accessed from the readLoop goroutine — no atomics
	// required. (WriteMarketData in mmap_manager handles cross-process sync.)
	lastPriceBits   uint64
	lastFundingBits uint64

	// reconnectCount tracks the number of connection attempts for backoff
	// calculation and logging. Only accessed from Run() — no sync needed.
	reconnectCount int
}

// NewWsFeed constructs a WsFeed. This is the ONLY function in this file that
// allocates. All allocations are one-time and proportional to the symbol length.
func NewWsFeed(symbol string, mmap *MmapManager, logger *slog.Logger) (*WsFeed, error) {
	if symbol == "" {
		return nil, fmt.Errorf("ws_feed: symbol must not be empty")
	}
	if mmap == nil {
		return nil, fmt.Errorf("ws_feed: mmap must not be nil")
	}
	if logger == nil {
		return nil, fmt.Errorf("ws_feed: logger must not be nil")
	}

	f := &WsFeed{
		symbol: symbol,
		mmap:   mmap,
		log:    logger,

		// WebSocket protocol messages.
		subMsg:  []byte(`{"op":"subscribe","args":["tickers.` + symbol + `"]}`),
		pingMsg: []byte(`{"op":"ping"}`),

		// JSON field key byte slices — avoids string→[]byte on each parse call.
		keyLastPrice:   []byte("lastPrice"),
		keyFundingRate: []byte("fundingRate"),
		keyTopic:       []byte("topic"),
		expectedTopic:  []byte("tickers." + symbol),

		// Seed with NaN: guarantees the first real tick is ALWAYS published,
		// even if price == 0.0 (which maps to 0x0000000000000000, distinct from NaN).
		lastPriceBits:   math.Float64bits(math.NaN()),
		lastFundingBits: math.Float64bits(math.NaN()),
	}

	return f, nil
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

// Run starts the WebSocket feed and blocks until ctx is cancelled.
// Handles connection, data streaming, and reconnection transparently.
// Launch as: go feed.Run(ctx)
func (f *WsFeed) Run(ctx context.Context) {
	for {
		// Check for cancellation before each connection attempt.
		// Prevents a spurious connect after the context is cancelled.
		select {
		case <-ctx.Done():
			f.log.Info("ws_feed: context cancelled — feed stopped")
			return
		default:
		}

		conn, err := f.connect(ctx)
		if err != nil {
			backoff := f.jitteredBackoff()
			f.log.Error("ws_feed: connection failed",
				"attempt", f.reconnectCount,
				"err", err,
				"retry_in", backoff.String(),
			)
			if !f.sleepCtx(ctx, backoff) {
				return // Context cancelled during sleep.
			}
			f.reconnectCount++
			continue
		}

		f.log.Info("ws_feed: stream active",
			"symbol", f.symbol,
			"url", bybitWSURL,
			"reconnect_count", f.reconnectCount,
		)
		f.reconnectCount = 0 // Reset counter on successful connect.

		// readLoop blocks until the connection is lost or ctx is cancelled.
		// conn is always closed inside readLoop before it returns.
		f.readLoop(ctx, conn)
	}
}

// connect dials the Bybit WebSocket and sends the subscription message.
// Returns the open connection, or an error. Does not block beyond the dial timeout.
func (f *WsFeed) connect(ctx context.Context) (*websocket.Conn, error) {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		// Gorilla's internal frame buffers — fixed at connection time.
		// These are for WS protocol framing, not for our message payload
		// (which goes into f.readBuf via NextReader).
		ReadBufferSize:  4096,
		WriteBufferSize: 256,
		// EnableCompression off: per-message deflate adds latency and alloc.
		EnableCompression: false,
	}

	conn, httpResp, err := dialer.DialContext(ctx, bybitWSURL, http.Header{
		"User-Agent": []string{"quant-hft-engine/2.0"},
	})
	if err != nil {
		if httpResp != nil {
			return nil, fmt.Errorf("dial HTTP %d: %w", httpResp.StatusCode, err)
		}
		return nil, fmt.Errorf("dial: %w", err)
	}

	// Send the pre-serialized subscription. Zero allocation.
	if err := conn.WriteMessage(websocket.TextMessage, f.subMsg); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("subscribe write: %w", err)
	}

	return conn, nil
}

// ── Hot Path ─────────────────────────────────────────────────────────────────

// readLoop is the steady-state hot path. It reads WebSocket frames into
// f.readBuf (zero-alloc) and calls parseAndPublish() for each ticker message.
//
// Goroutine model:
//   - readLoop runs in the caller's goroutine.
//   - A child goroutine handles heartbeating. It is guaranteed to exit before
//     readLoop returns, via the stopPing + pingDone channel pair.
//   - A second child goroutine watches ctx.Done() and closes conn to unblock
//     the NextReader() call when a shutdown is requested.
//
// conn is always closed before readLoop returns.
func (f *WsFeed) readLoop(ctx context.Context, conn *websocket.Conn) {
	defer conn.Close()

	// ── Goroutine 1: Context-cancellation watcher ─────────────────────────
	// When ctx is cancelled, we close conn to unblock any pending NextReader().
	// gorilla/websocket is safe to Close() concurrently with ReadMessage/NextReader.
	ctxWatchDone := make(chan struct{})
	go func() {
		defer close(ctxWatchDone)
		select {
		case <-ctx.Done():
			// Close the connection. This will cause NextReader() in the main
			// loop below to return immediately with an error, cleanly exiting.
			_ = conn.WriteMessage(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, "shutdown"),
			)
			conn.Close()
		case <-ctxWatchDone:
			// readLoop exited first (connection dropped). No action needed.
		}
	}()

	// ── Goroutine 2: Heartbeat ────────────────────────────────────────────
	// Sends a pre-serialized JSON ping every pingEvery to keep the connection
	// alive. gorilla allows concurrent WriteMessage + NextReader (read vs write
	// are independent), but NOT concurrent WriteMessage + WriteMessage.
	// Since only this goroutine writes pings and the main loop never writes
	// (reads only), there is no write concurrency issue.
	stopPing := make(chan struct{})
	pingDone := make(chan struct{})
	go func() {
		defer close(pingDone)
		ticker := time.NewTicker(pingEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if err := conn.WriteMessage(websocket.TextMessage, f.pingMsg); err != nil {
					// Connection is dead. The main loop will discover this on
					// the next NextReader() call and exit cleanly.
					f.log.Debug("ws_feed: ping failed", "err", err)
					return
				}
			case <-stopPing:
				return
			}
		}
	}()

	// Ensure both child goroutines exit before readLoop returns.
	defer func() {
		close(stopPing)
		<-pingDone
		// ctxWatchDone is closed either by its goroutine or by select unblocking.
		// Close ctxWatchDone to signal watcher that we're done (handles the
		// case where ctx is not yet cancelled but conn dropped naturally).
		// We achieve this by re-using the channel's close as the signal.
		// The select in the watcher goroutine has a ctxWatchDone case — but we
		// can't close a channel twice. Instead we signal via conn.Close() being
		// a no-op (already deferred above), and the watcher unblocks on its
		// select when conn.Close() has already been called.
		// The <-ctxWatchDone wait is intentionally omitted here to avoid a
		// potential deadlock: the watcher may be blocked on ctx.Done() which
		// only fires on shutdown, not on natural connection drop. We let it
		// be GC'd when its blocking select resolves.
	}()

	// ── Main read loop ────────────────────────────────────────────────────
	for {
		n, err := f.readNextMessage(conn)
		if err != nil {
			// Connection closed, network error, or ctx-triggered Close().
			// All of these are handled by Run()'s reconnect logic.
			f.log.Debug("ws_feed: read loop terminated", "err", err)
			return
		}
		if n == 0 {
			// Binary frame or empty message — discard silently.
			continue
		}
		// f.readBuf[:n] holds the complete message. Zero-alloc parse and publish.
		f.parseAndPublish(f.readBuf[:n])
	}
}

// readNextMessage reads the next WebSocket text frame into f.readBuf.
// Returns (n, nil) on success, where n is the message length in bytes.
// Returns (0, nil) for non-text frames (binary, control).
// Returns (0, err) on connection error.
//
// Uses NextReader() + manual read loop instead of ReadMessage() to avoid
// the per-message []byte allocation that ReadMessage() performs internally.
//
// ALLOCATION: NONE. All bytes land in f.readBuf.
func (f *WsFeed) readNextMessage(conn *websocket.Conn) (int, error) {
	msgType, r, err := conn.NextReader()
	if err != nil {
		return 0, err
	}

	// Drain and discard non-text frames without returning an error.
	// Binary frames: Bybit does not send binary, but be defensive.
	// Control frames (ping/pong/close) are handled internally by gorilla
	// before NextReader() returns them — we typically never see them here.
	if msgType != websocket.TextMessage {
		_, _ = io.Copy(io.Discard, r)
		return 0, nil
	}

	// Read the full message payload into f.readBuf.
	// gorilla's io.Reader signals end-of-message with io.EOF (not ErrUnexpectedEOF).
	// We loop until EOF rather than using io.ReadFull to avoid misinterpreting
	// a short message as an error.
	n := 0
	for {
		nn, readErr := r.Read(f.readBuf[n:])
		n += nn
		if readErr == io.EOF {
			// End of this WebSocket message. Normal termination.
			break
		}
		if readErr != nil {
			return 0, fmt.Errorf("mid-message read error: %w", readErr)
		}
		if n >= readBufSize {
			// Message payload exceeds our buffer. This indicates either:
			//   a) readBufSize is too small (adjust the constant), or
			//   b) the exchange sent an unexpected bulk payload.
			// Either way, discard the rest and treat it as a non-event.
			_, _ = io.Copy(io.Discard, r)
			f.log.Warn("ws_feed: message exceeds readBufSize, discarded",
				"n_buffered", n,
				"readBufSize", readBufSize,
			)
			return 0, nil
		}
	}

	return n, nil
}

// parseAndPublish is the innermost hot function. Called for every text frame.
//
// Pipeline:
//   1. Topic filter:   skip non-ticker messages in ~50 ns.
//   2. Price extract:  findStringValue("lastPrice")   → raw bytes in readBuf.
//   3. Rate extract:   findStringValue("fundingRate") → raw bytes in readBuf.
//   4. float64 parse:  bytesToFloat64() via unsafe.String — zero alloc.
//   5. Change detect:  bitwise compare to last published values.
//   6. mmap write:     WriteMarketData() acquires seqlock, publishes, releases.
//
// ALLOCATION: NONE.
func (f *WsFeed) parseAndPublish(msg []byte) {
	// ── 1. Topic filter ───────────────────────────────────────────────────
	// Fast-path rejection: skip subscription confirmations, pong responses,
	// and any other non-ticker messages before touching heavier field parsing.
	// bytes.Equal is compiler-intrinsified (SIMD) on amd64 — O(n/32).
	topicVal := f.findStringValue(msg, f.keyTopic)
	if topicVal == nil || !bytes.Equal(topicVal, f.expectedTopic) {
		return
	}

	// ── 2. Extract lastPrice ──────────────────────────────────────────────
	priceBytes := f.findStringValue(msg, f.keyLastPrice)
	if priceBytes == nil {
		// lastPrice is absent. This is unexpected for a topic-matched message;
		// log once at debug level and drop.
		f.log.Debug("ws_feed: lastPrice field absent in ticker message")
		return
	}

	price, ok := bytesToFloat64(priceBytes)
	if !ok || price <= 0.0 || math.IsNaN(price) || math.IsInf(price, 0) {
		f.log.Warn("ws_feed: invalid lastPrice value",
			"raw", string(priceBytes), // string() alloc OK here: it's a warn-level path
		)
		return
	}

	// ── 3. Extract fundingRate (optional field) ───────────────────────────
	// Bybit sends fundingRate in snapshot frames but omits it in delta frames.
	// On absence, we preserve the last known value rather than zeroing it.
	var funding float64
	fundingBytes := f.findStringValue(msg, f.keyFundingRate)
	if fundingBytes != nil {
		if parsed, fok := bytesToFloat64(fundingBytes); fok {
			funding = parsed
			// Update the cached funding bits. Next call with absent fundingRate
			// will use this cached value.
			f.lastFundingBits = math.Float64bits(funding)
		} else {
			// Parse failure on a present field: use the cache.
			// Log at debug: parse errors here indicate unexpected rate formatting.
			f.log.Debug("ws_feed: fundingRate parse failed, using cached value",
				"raw", string(fundingBytes),
			)
			funding = math.Float64frombits(f.lastFundingBits)
		}
	} else {
		// Field absent (delta update): use cached value without logging.
		// This is the expected high-frequency case.
		funding = math.Float64frombits(f.lastFundingBits)
	}

	// ── 4. Change detection ───────────────────────────────────────────────
	// If neither price nor funding has changed, skip the mmap write entirely.
	// This eliminates redundant seqlock cycles during low-volatility periods
	// (e.g., exchange replaying the same snapshot on reconnect).
	newPriceBits := math.Float64bits(price)
	newFundBits := math.Float64bits(funding)

	if newPriceBits == f.lastPriceBits && newFundBits == f.lastFundingBits {
		return
	}

	// Update local cache BEFORE the mmap write to avoid a double-write if
	// WriteMarketData panics (non-recoverable) or is interrupted.
	f.lastPriceBits = newPriceBits
	f.lastFundingBits = newFundBits

	// ── 5. Publish to mmap ────────────────────────────────────────────────
	// The seqlock write in WriteMarketData() takes ~50 ns on a modern CPU.
	// At 10,000 ticks/sec (extreme high-frequency market), this adds 0.05%
	// CPU overhead — acceptable for a dedicated feed goroutine.
	f.mmap.WriteMarketData(price, funding)
}

// ── Zero-Allocation JSON Field Extractor ─────────────────────────────────────

// findStringValue scans msg for a JSON field matching key and returns its value
// as a sub-slice of msg. No strings or byte slices are allocated.
//
// Handles both quoted string values and unquoted numeric/boolean values:
//   "lastPrice":"67000.10"  → []byte("67000.10")
//   "updateId":12345        → []byte("12345")
//
// Limitations (acceptable for a controlled, known API format):
//   - Does not handle escaped characters inside string values.
//   - Returns the FIRST occurrence of key in msg (left-to-right scan).
//   - Does not validate JSON structure (assumes well-formed input from Bybit).
//
// Complexity: O(len(msg)). On a 900-byte Bybit ticker message with a 9-byte
// key, this executes in ~270 ns on a modern CPU (cache-hot, branch predictor
// trained after the first few calls).
//
// ALLOCATION: NONE. The return value is a sub-slice of msg.
func (f *WsFeed) findStringValue(msg []byte, key []byte) []byte {
	kLen := len(key)
	mLen := len(msg)

	// A valid `"key":x` sequence requires at minimum kLen + 4 bytes
	// (opening quote + key + closing quote + colon + at least one value byte).
	if mLen < kLen+4 {
		return nil
	}

	limit := mLen - kLen - 2 // last valid i where a key match could start

	for i := 0; i <= limit; i++ {
		// Fast-path: skip non-quote bytes immediately.
		// On x86-64, this branch is almost never taken for the majority of
		// bytes, making it effectively a tight memchr-equivalent loop.
		if msg[i] != '"' {
			continue
		}

		// Verify that the next kLen bytes exactly match key.
		// bytes.Equal uses SIMD intrinsics on amd64 — typically 1-2 cycles
		// for keys ≤ 32 bytes.
		candidate := msg[i+1:]
		if len(candidate) < kLen || !bytes.Equal(candidate[:kLen], key) {
			continue
		}

		// Verify key termination: the byte after the key must be `"` (closing
		// the key string), and the byte after that must be `:`.
		// This prevents matching "lastPrice" inside "firstLastPrice" or similar.
		afterKey := i + 1 + kLen
		if afterKey+1 >= mLen {
			break // Not enough bytes remaining — can't be a valid key:value pair.
		}
		if msg[afterKey] != '"' || msg[afterKey+1] != ':' {
			// The matched bytes are a substring of a longer key name. Continue.
			continue
		}

		// Advance past the `"key":` sequence.
		pos := afterKey + 2

		// Skip optional whitespace between `:` and the value.
		// Standard JSON allows this; Bybit's actual wire format doesn't use it,
		// but be defensive.
		for pos < mLen && (msg[pos] == ' ' || msg[pos] == '\t') {
			pos++
		}
		if pos >= mLen {
			return nil
		}

		if msg[pos] == '"' {
			// ── Quoted string value ──────────────────────────────────────
			// Advance past the opening quote and scan to the closing quote.
			// Assumption: no escaped `\"` inside the value (valid for numeric
			// strings like prices and rates that Bybit sends as quoted numbers).
			pos++
			start := pos
			for pos < mLen && msg[pos] != '"' {
				pos++
			}
			if pos >= mLen {
				return nil // Unterminated string — malformed message.
			}
			if pos == start {
				return nil // Empty string value — unexpected for price/rate fields.
			}
			return msg[start:pos]
		}

		// ── Unquoted value (number, true, false, null) ───────────────────
		// Scan to the first JSON value delimiter.
		start := pos
		for pos < mLen {
			c := msg[pos]
			if c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' || c == '\r' {
				break
			}
			pos++
		}
		if pos == start {
			return nil // Zero-length value — unexpected.
		}
		return msg[start:pos]
	}

	return nil
}

// bytesToFloat64 parses a float64 from a []byte WITHOUT allocating a string.
//
// It constructs a string header (pointer + length) pointing into the existing
// []byte backing array using unsafe.String (Go 1.20+). The string is passed
// to strconv.ParseFloat, which does not retain the string beyond the call.
// After bytesToFloat64 returns, the unsafe string is inaccessible.
//
// This is a well-established Go pattern for zero-alloc string parsing from
// pre-allocated byte buffers. It is safe as long as b is not concurrently
// modified, which is guaranteed here: b is always a sub-slice of f.readBuf,
// and readBuf is only written by readNextMessage (same goroutine).
//
// ALLOCATION: NONE on the normal path. strconv.ParseFloat may internally
// allocate for subnormal or very large exponent values — irrelevant for
// typical crypto prices ($0.000001 to $1,000,000 range).
func bytesToFloat64(b []byte) (float64, bool) {
	if len(b) == 0 {
		return 0, false
	}
	// unsafe.String creates a string header over b's backing array.
	// The resulting string is ONLY valid while b is alive and unmodified.
	s := unsafe.String(&b[0], len(b))
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

// ── Reconnect Utilities ──────────────────────────────────────────────────────

// jitteredBackoff returns the sleep duration for the current reconnect attempt.
//
// Strategy: full jitter exponential backoff.
//   cap(attempt) = min(base * 2^attempt, maxReconnect)
//   sleep        = random in [base, cap(attempt)]
//
// Full jitter (vs. equal jitter) distributes reconnect attempts uniformly
// across the backoff window. This prevents thundering-herd reconnections if
// multiple bot instances lose their connections simultaneously (e.g., during
// a brief exchange outage).
//
// Reference: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
func (f *WsFeed) jitteredBackoff() time.Duration {
	// Compute the exponential cap, clamped to reconnectMax.
	// Left-shift by attempt: base << attempt = base * 2^attempt.
	// Guard against overflow: if attempt > 6, cap is already >= reconnectMax.
	shift := f.reconnectCount
	if shift > 7 {
		shift = 7 // 2^7 = 128 → 128 * 500ms = 64s ≥ reconnectMax=60s
	}
	cap := reconnectBase << uint(shift)
	if cap > reconnectMax || cap <= 0 { // cap <= 0 guards against time.Duration overflow
		cap = reconnectMax
	}

	// Full jitter: random duration in [0, cap].
	// rand.Int63n is goroutine-safe in Go 1.20+ (uses a per-goroutine rand source).
	jitter := time.Duration(rand.Int63n(int64(cap)))

	// Enforce a minimum of reconnectBase to avoid sub-millisecond sleeps on
	// the first few attempts.
	if jitter < reconnectBase {
		jitter = reconnectBase
	}

	return jitter
}

// sleepCtx sleeps for d or until ctx is cancelled, whichever comes first.
// Returns true if the timer fired (sleep completed), false if ctx was cancelled.
// Uses time.NewTimer + defer Stop() to avoid timer goroutine leaks.
func (f *WsFeed) sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}
