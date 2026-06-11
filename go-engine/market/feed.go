// go-engine/market/feed.go
//
// ═══════════════════════════════════════════════════════════════════════════
// CHANGELOG FIX-F BATCH:
//
// [FIX-F1] DYNAMIC SYMBOL SWITCHING — Root Fix Problem 1
//   ROOT CAUSE: Feed di-init sekali dengan symbol dari startup config.
//   Saat user ganti pair di dashboard lalu klik START, Go engine masih
//   pakai symbol lama karena:
//     (a) wsConnect() hardcode subscribe ke symbol awal
//     (b) fetchOHLCV/fetchAux pakai f.state.Symbol yang di-set sekali
//     (c) Tidak ada mekanisme restart WS/REST saat symbol berubah
//   FIX: Ganti f.state.Symbol (protected by mutex) dengan atomic.Value
//   sehingga UpdateSymbol() bisa dipanggil dari main.go tanpa race.
//   WS loop membaca symbol via getSymbol() setiap reconnect cycle.
//   OHLCV + Aux juga membaca via getSymbol() bukan cache stale.
//
// [FIX-F2] WS RECONNECT ON SYMBOL CHANGE
//   ROOT CAUSE: Saat symbol ganti, WS masih subscribe ke pair lama.
//   FIX: wsConnect() sekarang listen ke f.symChangeCh. Jika dapat signal,
//   tutup koneksi WS saat ini (return error) → wsTickerLoop reconnect
//   otomatis dengan symbol baru dari getSymbol().
//
// [FIX-F3] OHLCV/AUX CACHE INVALIDATION SAAT SYMBOL GANTI
//   ROOT CAUSE: Setelah symbol ganti, candle lama (pair lama) masih ada
//   di f.state.Candles dan bisa menyebabkan analisa salah untuk beberapa
//   siklus pertama.
//   FIX: UpdateSymbol() reset Candles + ATR14 ke zero sebelum symbol
//   diupdate, sehingga SHM flush tidak mengirim data lama ke Rust brain.
//
// [FIX-F4] GOROUTINE LEAK PREVENTION
//   ROOT CAUSE: Jika Run() dipanggil berkali-kali (misalnya restart),
//   goroutine lama bisa tetap jalan karena tidak ada mekanisme shutdown.
//   FIX: Run() sekarang terima context dan semua goroutine di-select
//   pada ctx.Done() dengan benar (sudah ada, diperkuat).
// ═══════════════════════════════════════════════════════════════════════════

package market

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"tradebot/go-engine/shm"
)

const (
	bybitWSMain   = "wss://stream.bytick.com/v5/public/linear"
	bybitRESTMain = "https://api.bytick.com"
	pingInterval  = 20 * time.Second
)

// State adalah shared state antara goroutine WS, OHLCV, dan Aux.
type State struct {
	mu sync.RWMutex

	// From WebSocket
	Price    float64
	Bid      float64
	Ask      float64
	RawTicks []shm.RawTick

	// From REST OHLCV
	Candles []shm.Candle
	ATR14   float64

	// From REST Aux
	OI          float64
	LSR         float64
	FundingRate float64

	// Macro (zeroed until external feeds integrated)
	USDTDeltaPct   float64
	KimchiPct      float64
	WhaleInflowUSD float64
	LongLiq1h      float64
	ShortLiq1h     float64

	// Sentiment (dari RSS goroutine — Linguist input)
	SentimentScore float32
	NewsCount      uint32
	Pct24h         float64

	// [FIX-F1] Symbol DIHAPUS dari State — dipindah ke atomic.Value di Feed
	// agar UpdateSymbol() tidak perlu lock State mutex
}

// Feed mengorkestrasi semua data source dan menulis ke SHM setiap price update.
type Feed struct {
	state   State
	bridge  *shm.Bridge
	client  *http.Client
	ohlcvTF string
	limit   int

	// [FIX-F1] Symbol disimpan sebagai atomic.Value agar UpdateSymbol()
	// bisa dipanggil dari goroutine manapun (termasuk main.go signal loop)
	// tanpa menyentuh State mutex yang bisa deadlock dengan WS goroutine.
	atomicSymbol atomic.Value // stores string

	// [FIX-F2] Channel untuk trigger WS reconnect saat symbol berubah.
	// Buffer=1 agar UpdateSymbol() tidak block jika WS sedang reconnect.
	symChangeCh     chan struct{}
	symChangeRestCh chan struct{}

	isBacktesting atomic.Bool

	// Exchange Driver (Fallback mechanism)
	driverMu sync.RWMutex
	driver   ExchangeDriver
}

func (f *Feed) getDriver() ExchangeDriver {
	f.driverMu.RLock()
	defer f.driverMu.RUnlock()
	return f.driver
}

func (f *Feed) SwitchDriver(newDriver ExchangeDriver) {
	f.driverMu.Lock()
	oldName := ""
	if f.driver != nil {
		oldName = f.driver.Name()
	}
	f.driver = newDriver
	f.driverMu.Unlock()

	if oldName != newDriver.Name() {
		log.Printf("[Feed][%s] Switched CEX Driver: %s -> %s", f.getSymbol(), oldName, newDriver.Name())
		// Trigger reconnect on driver change
		select {
		case f.symChangeCh <- struct{}{}:
		default:
		}
		select {
		case f.symChangeRestCh <- struct{}{}:
		default:
		}
	}
}

func (f *Feed) SetBacktesting(v bool) {
	f.isBacktesting.Store(v)
}

func (f *Feed) IsBacktesting() bool {
	return f.isBacktesting.Load()
}

// New membuat Feed baru. Symbol awal dari parameter, bisa diganti via UpdateSymbol().
func New(symbol, ohlcvTF string, limit int, initDriver ExchangeDriver) *Feed {
	if initDriver == nil {
		initDriver = &BybitDriver{}
	}
	f := &Feed{
		client:          &http.Client{Timeout: 10 * time.Second},
		ohlcvTF:         ohlcvTF,
		limit:           limit,
		symChangeCh:     make(chan struct{}, 1),
		symChangeRestCh: make(chan struct{}, 1),
		driver:          initDriver,
	}
	// [FIX-F1] Init atomic symbol
	f.atomicSymbol.Store(symbol)
	return f
}

// getSymbol returns current trading symbol (thread-safe).
// [FIX-F1] Semua internal caller pakai ini, bukan f.state.Symbol.
func (f *Feed) getSymbol() string {
	if s, ok := f.atomicSymbol.Load().(string); ok && s != "" {
		return s
	}
	return "BTCUSDT" // fallback
}

// UpdateSymbol switches the active trading pair.
// [FIX-F1] Dipanggil dari main.go ketika user klik START dengan symbol baru.
// [FIX-F3] Reset OHLCV cache agar candle lama tidak kontaminasi analisa baru.
// [FIX-F2] Trigger WS reconnect untuk subscribe ke pair baru.
func (f *Feed) UpdateSymbol(newSymbol string) {
	oldSymbol := f.getSymbol()
	if oldSymbol == newSymbol {
		return // tidak ada perubahan, skip
	}

	log.Printf("[Feed] ⚡ Symbol change: %s → %s", oldSymbol, newSymbol)

	// [FIX-F3] Clear candle cache SEBELUM ganti symbol
	// Ini mencegah Rust brain menerima candle BTCUSDT saat sudah di-set ke SOLUSDT
	f.state.mu.Lock()
	f.state.Candles = nil
	f.state.ATR14   = 0
	f.state.Price   = 0
	f.state.OI      = 0
	f.state.LSR     = 0
	f.state.RawTicks = nil
	f.state.mu.Unlock()

	// [FIX-F1] Update atomic symbol (tidak perlu lock, atomic.Value thread-safe)
	f.atomicSymbol.Store(newSymbol)

	// [FIX-F2] Signal WS goroutine untuk reconnect dengan symbol baru
	// Non-blocking: jika channel sudah ada pesan, skip (WS sudah akan reconnect)
	select {
	case f.symChangeCh <- struct{}{}:
		log.Printf("[Feed] WS reconnect triggered for %s", newSymbol)
	default:
		// Channel sudah ada pending reconnect, tidak perlu kirim lagi
	}

	select {
	case f.symChangeRestCh <- struct{}{}:
	default:
	}
}

// Run menjalankan semua goroutine; block sampai ctx cancel.
func (f *Feed) Run(ctx context.Context) {
	sym := f.getSymbol() // [FIX-F1] pakai getSymbol()
	log.Printf("[Feed] Starting for %s tf=%s limit=%d", sym, f.ohlcvTF, f.limit)

	// Prime OHLCV synchronously sebelum WS start
	if err := f.fetchOHLCV(f.getSymbol()); err != nil {
		log.Printf("[Feed] Initial OHLCV fetch failed: %v", err)
	}
	_ = f.fetchAux(f.getSymbol())
	_ = f.fetch24h(f.getSymbol())

	var wg sync.WaitGroup

	// WebSocket price feed
	wg.Add(1)
	go func() {
		defer wg.Done()
		f.wsTickerLoop(ctx)
	}()

	// OHLCV refresh tiap 60 detik
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(60 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// [FIX-F1] Baca symbol saat refresh, bukan cache stale
				if err := f.fetchOHLCV(f.getSymbol()); err != nil {
					log.Printf("[Feed] OHLCV refresh error: %v", err)
				}
			}
		}
	}()

	// Aux (OI, LSR, Funding) refresh tiap 30 detik
	wg.Add(1)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// [FIX-F1] Baca symbol saat refresh
				_ = f.fetchAux(f.getSymbol())
			}
		}
	}()

	// [FIX-F1] Goroutine watcher: saat symbol berubah, trigger OHLCV refetch
	// (WS reconnect sudah di-handle oleh wsTickerLoop via symChangeCh)
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-ctx.Done():
				return
			case <-f.symChangeRestCh:
				newSym := f.getSymbol()
				log.Printf("[Feed] Symbol changed to %s — refetching OHLCV+Aux", newSym)
				// Fetch OHLCV untuk symbol baru
				if err := f.fetchOHLCV(newSym); err != nil {
					log.Printf("[Feed] OHLCV fetch for new symbol %s failed: %v", newSym, err)
				}
				_ = f.fetchAux(newSym)
				// Drain symChangeRestCh jika ada pesan duplikat
				for {
					select {
					case <-f.symChangeRestCh:
					default:
						goto drained
					}
				}
			drained:
			}
		}
	}()

	wg.Wait()
}

// ── WebSocket Ticker ──────────────────────────────────────────────────────────

// [FIX-F2] wsTickerLoop tidak lagi pass symbol sebagai parameter tetap.
// Setiap reconnect cycle membaca symbol terbaru dari getSymbol().
func (f *Feed) wsTickerLoop(ctx context.Context) {
	backoff := time.Second
	for {
		select {
		case <-ctx.Done(): return
		default:
		}
		for {
			select {
			case <-f.symChangeCh:
			default:
				goto drainedWS
			}
		}
	drainedWS:

		sym := f.getSymbol()
		driver := f.getDriver()
		
		updateChan := make(chan WSMsg, 100)
		errChan := make(chan error, 1)
		
		wsCtx, wsCancel := context.WithCancel(ctx)
		go driver.WSConnect(wsCtx, sym, updateChan, errChan)
		
		// Goroutine watcher for symbol change
		go func() {
			select {
			case <-wsCtx.Done(): return
			case <-f.symChangeCh:
				log.Printf("[Feed] Symbol change detected — closing WS for %s", sym)
				wsCancel()
			}
		}()

		var wsErr error
	wsListen:
		for {
			select {
			case <-wsCtx.Done():
				break wsListen
			case err := <-errChan:
				wsErr = err
				wsCancel()
				break wsListen
			case msg := <-updateChan:
				f.state.mu.Lock()
				if msg.Type == "ticker" {
					f.state.Price = msg.Price
					if msg.Bid > 0 { f.state.Bid = msg.Bid }
					if msg.Ask > 0 { f.state.Ask = msg.Ask }
				} else if msg.Type == "trade" {
					f.state.RawTicks = append(f.state.RawTicks, msg.Trade...)
					if len(f.state.RawTicks) > 1000 {
						f.state.RawTicks = f.state.RawTicks[len(f.state.RawTicks)-1000:]
					}
				}
				f.state.mu.Unlock()
			}
		}

		if wsErr != nil {
			if sym != f.getSymbol() {
				backoff = time.Second
				continue
			}
			log.Printf("[Feed][%s] WS error: %v — reconnect in %s", sym, wsErr, backoff)
			
			// Simple dynamic CEX rotation logic
			if f.getDriver().Name() == "Bybit" {
				log.Printf("[Feed][%s] Fallback to Binance...", sym)
				f.SwitchDriver(&BinanceDriver{})
			} else if f.getDriver().Name() == "Binance" {
				log.Printf("[Feed][%s] Fallback to OKX...", sym)
				f.SwitchDriver(&OKXDriver{})
			} else if f.getDriver().Name() == "OKX" {
				log.Printf("[Feed][%s] Fallback to MEXC...", sym)
				f.SwitchDriver(&MEXCDriver{})
			} else {
				log.Printf("[Feed][%s] Fallback to Bybit...", sym)
				f.SwitchDriver(&BybitDriver{})
			}
		}

		select {
		case <-ctx.Done(): return
		case <-time.After(backoff):
		}
		if backoff < 60*time.Second { backoff *= 2 }
	}
}

// ── REST helpers ──────────────────────────────────────────────────────────────

func (f *Feed) fetchOHLCV(symbol string) error {
	driver := f.getDriver()
	candles, err := driver.FetchOHLCV(f.client, symbol, f.ohlcvTF, f.limit)
	if err != nil {
		if err.Error() == "rate_limit" {
			log.Printf("[Feed][%s] Rate limit detected on %s for OHLCV", symbol, driver.Name())
			// Trigger fallback logic
			if driver.Name() == "Bybit" { f.SwitchDriver(&BinanceDriver{}) }
		}
		return err
	}

	atr := wilderATR(candles, 14)

	if f.getSymbol() != symbol { return nil }

	f.state.mu.Lock()
	f.state.Candles = candles
	f.state.ATR14 = atr
	f.state.mu.Unlock()

	log.Printf("[Feed] OHLCV refreshed: %s %d candles ATR14=%.4f (Driver: %s)", symbol, len(candles), atr, driver.Name())
	return nil
}

func (f *Feed) fetchAux(symbol string) error {
	driver := f.getDriver()
	oi, lsr, funding, pct24h, err := driver.FetchAux(f.client, symbol)
	if err != nil { return err }
	
	if f.getSymbol() == symbol {
		f.state.mu.Lock()
		if oi > 0 { f.state.OI = oi }
		if lsr > 0 { f.state.LSR = lsr }
		if funding != 0 { f.state.FundingRate = funding }
		if pct24h != 0 { f.state.Pct24h = pct24h }
		f.state.mu.Unlock()
	}
	return nil
}

func (f *Feed) fetch24h(symbol string) error {
	url := fmt.Sprintf("%s/v5/market/tickers?category=linear&symbol=%s", bybitRESTMain, symbol)
	if pct, err := fetchSpecificFloat(f.client, url, "price24hPcnt"); err == nil {
		f.state.mu.Lock()
		f.state.Pct24h = pct * 100.0 // bybit returns 0.01 for 1%
		f.state.mu.Unlock()
	} else {
		// Fallback for some reason
		log.Printf("[Feed] Failed to fetch initial 24h Pct for %s: %v", symbol, err)
	}
	return nil
}

func lsrBiasLabel(lsr float64) string {
	if lsr > 1.05 {
		return "LONG_HEAVY"
	} else if lsr < 0.95 {
		return "SHORT_HEAVY"
	}
	return "NEUTRAL"
}

// ── SHM Flush ─────────────────────────────────────────────────────────────────

var flushSeq uint64

func (f *Feed) GetMarketData(symbol string) *shm.MarketData {
	f.state.mu.Lock()
	s := f.state
	// Clear the raw ticks so we don't send duplicates next cycle
	f.state.RawTicks = nil
	f.state.mu.Unlock()

	if s.Price <= 0 || len(s.Candles) == 0 {
		return nil
	}

	var sym [16]byte
	copy(sym[:], symbol)

	md := &shm.MarketData{
		Symbol:         sym,
		Candles:        s.Candles,
		RawTicks:       s.RawTicks,
		Price:          s.Price,
		Bid:            s.Bid,
		Ask:            s.Ask,
		OI:             s.OI,
		LSR:            s.LSR,
		ATR14:          s.ATR14,
		FundingRate:    s.FundingRate,
		USDTDeltaPct:   s.USDTDeltaPct,
		KimchiPct:      s.KimchiPct,
		WhaleInflowUSD: s.WhaleInflowUSD,
		LongLiq1h:      s.LongLiq1h,
		ShortLiq1h:     s.ShortLiq1h,
		SentimentScore: s.SentimentScore,
		NewsCount:      s.NewsCount,
		TsMs:           time.Now().UnixMilli(),
	}

	return md
}

// ── Math helpers ──────────────────────────────────────────────────────────────

func wilderATR(candles []shm.Candle, period int) float64 {
	if len(candles) < 2 {
		return 0
	}
	var trs []float64
	for i := 1; i < len(candles); i++ {
		h, l, pc := candles[i].High, candles[i].Low, candles[i-1].Close
		tr := math.Max(h-l, math.Max(math.Abs(h-pc), math.Abs(l-pc)))
		trs = append(trs, tr)
	}
	if len(trs) == 0 {
		return 0
	}
	seedN := period
	if seedN > len(trs) {
		seedN = len(trs)
	}
	var atr float64
	for _, v := range trs[:seedN] {
		atr += v
	}
	atr /= float64(seedN)
	alpha := 1.0 / float64(period)
	for _, v := range trs[seedN:] {
		atr = atr*(1-alpha) + v*alpha
	}
	return atr
}

// ── REST parsers ──────────────────────────────────────────────────────────────

func fetchSpecificFloat(client *http.Client, url string, fieldName string) (float64, error) {
	resp, err := client.Get(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	var payload struct {
		RetCode int `json:"retCode"`
		Result  struct {
			List []map[string]json.RawMessage `json:"list"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("parse response: %w", err)
	}
	if payload.RetCode != 0 {
		return 0, fmt.Errorf("bybit retCode %d", payload.RetCode)
	}
	if len(payload.Result.List) == 0 {
		return 0, fmt.Errorf("empty list")
	}

	raw, ok := payload.Result.List[0][fieldName]
	if !ok {
		return 0, fmt.Errorf("field '%s' not found in response", fieldName)
	}

	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		var fv float64
		if err2 := json.Unmarshal(raw, &fv); err2 != nil {
			return 0, fmt.Errorf("cannot parse field '%s': %w", fieldName, err)
		}
		return fv, nil
	}
	return strconv.ParseFloat(s, 64)
}

func fetchLSR(client *http.Client, url string) (buy, sell float64, err error) {
	resp, err := client.Get(url)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	var payload struct {
		Result struct {
			List []struct {
				BuyRatio  string `json:"buyRatio"`
				SellRatio string `json:"sellRatio"`
			} `json:"list"`
		} `json:"result"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err = json.Unmarshal(body, &payload); err != nil {
		return
	}
	if len(payload.Result.List) == 0 {
		err = fmt.Errorf("empty LSR list")
		return
	}
	buy, _ = strconv.ParseFloat(payload.Result.List[0].BuyRatio, 64)
	sell, _ = strconv.ParseFloat(payload.Result.List[0].SellRatio, 64)
	return
}

// UpdateSentiment dipanggil oleh RSS goroutine di main.go.
func (f *Feed) UpdateSentiment(score float32, count uint32) {
	f.state.mu.Lock()
	f.state.SentimentScore = score
	f.state.NewsCount = count
	f.state.mu.Unlock()
}

// UpdateMacro mengupdate field macro Absurdist.
func (f *Feed) UpdateMacro(usdtDelta, kimchi, whaleInflow, longLiq, shortLiq float64) {
	f.state.mu.Lock()
	f.state.USDTDeltaPct = usdtDelta
	f.state.KimchiPct = kimchi
	f.state.WhaleInflowUSD = whaleInflow
	f.state.LongLiq1h = longLiq
	f.state.ShortLiq1h = shortLiq
	f.state.mu.Unlock()
}
