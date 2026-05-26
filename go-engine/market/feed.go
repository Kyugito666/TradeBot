// go-engine/market/feed.go
//
// FIX v3.0.2:
//   - fetchSpecificFloat() menggantikan fetchSingleFloat() yang asal-asalan pick field
//     dari JSON map (non-deterministic order → kadang dapet "timestamp" bukan "openInterest")
//   - OI, LSR, FundingRate sekarang masing-masing pick field by name, bukan random
//   - Log OI sudah include unit jelas (contracts) supaya tidak salah interpret

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

	"github.com/gorilla/websocket"
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
	Price float64
	Bid   float64
	Ask   float64

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

	Symbol string
}

// Feed mengorkestrasi semua data source dan menulis ke SHM setiap price update.
type Feed struct {
	state   State
	bridge  *shm.Bridge
	client  *http.Client
	ohlcvTF string
	limit   int
}

func New(bridge *shm.Bridge, symbol, ohlcvTF string, limit int) *Feed {
	return &Feed{
		bridge:  bridge,
		client:  &http.Client{Timeout: 10 * time.Second},
		ohlcvTF: ohlcvTF,
		limit:   limit,
		state:   State{Symbol: symbol},
	}
}

// Run menjalankan semua goroutine; block sampai ctx cancel.
func (f *Feed) Run(ctx context.Context) {
	sym := f.state.Symbol
	log.Printf("[Feed] Starting for %s tf=%s limit=%d", sym, f.ohlcvTF, f.limit)

	// Prime OHLCV synchronously sebelum WS start
	if err := f.fetchOHLCV(sym); err != nil {
		log.Printf("[Feed] Initial OHLCV fetch failed: %v", err)
	}
	_ = f.fetchAux(sym)

	var wg sync.WaitGroup

	// WebSocket price feed
	wg.Add(1)
	go func() {
		defer wg.Done()
		f.wsTickerLoop(ctx, sym)
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
				if err := f.fetchOHLCV(sym); err != nil {
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
				_ = f.fetchAux(sym)
			}
		}
	}()

	wg.Wait()
}

// ── WebSocket Ticker ──────────────────────────────────────────────────────────

func (f *Feed) wsTickerLoop(ctx context.Context, symbol string) {
	backoff := time.Second
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		if err := f.wsConnect(ctx, symbol); err != nil {
			log.Printf("[Feed] WS error: %v — reconnect in %s", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 60*time.Second {
			backoff *= 2
		}
	}
}

func (f *Feed) wsConnect(ctx context.Context, symbol string) error {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, bybitWSMain, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	sub := map[string]interface{}{
		"op":   "subscribe",
		"args": []string{fmt.Sprintf("tickers.%s", symbol)},
	}
	if err := conn.WriteJSON(sub); err != nil {
		return err
	}
	log.Printf("[Feed] WS connected — subscribed to tickers.%s", symbol)

	pingCtx, pingCancel := context.WithCancel(ctx)
	defer pingCancel()
	go func() {
		tick := time.NewTicker(pingInterval)
		defer tick.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-tick.C:
				_ = conn.WriteJSON(map[string]string{"op": "ping"})
			}
		}
	}()

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return err
		}

		var raw map[string]json.RawMessage
		if err := json.Unmarshal(msg, &raw); err != nil {
			continue
		}
		topic, _ := strconv.Unquote(string(raw["topic"]))
		if topic != fmt.Sprintf("tickers.%s", symbol) {
			continue
		}
		var data struct {
			LastPrice string `json:"lastPrice"`
			Bid1Price string `json:"bid1Price"`
			Ask1Price string `json:"ask1Price"`
		}
		if err := json.Unmarshal(raw["data"], &data); err != nil {
			continue
		}

		price, _ := strconv.ParseFloat(data.LastPrice, 64)
		bid, _ := strconv.ParseFloat(data.Bid1Price, 64)
		ask, _ := strconv.ParseFloat(data.Ask1Price, 64)

		if price <= 0 {
			continue
		}

		f.state.mu.Lock()
		f.state.Price = price
		if bid > 0 {
			f.state.Bid = bid
		}
		if ask > 0 {
			f.state.Ask = ask
		}
		f.state.mu.Unlock()

		f.flushToSHM(symbol)
	}
}

// ── REST helpers ──────────────────────────────────────────────────────────────

func (f *Feed) fetchOHLCV(symbol string) error {
	url := fmt.Sprintf(
		"%s/v5/market/kline?category=linear&symbol=%s&interval=%s&limit=%d",
		bybitRESTMain, symbol, f.ohlcvTF, f.limit,
	)
	resp, err := f.client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var payload struct {
		RetCode int `json:"retCode"`
		Result  struct {
			List [][]string `json:"list"`
		} `json:"result"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &payload); err != nil {
		return err
	}
	if payload.RetCode != 0 {
		return fmt.Errorf("bybit retCode %d", payload.RetCode)
	}

	rows := payload.Result.List
	// Bybit returns newest-first → reverse to oldest-first for Rust
	candles := make([]shm.Candle, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if len(r) < 6 {
			continue
		}
		ts, _ := strconv.ParseInt(r[0], 10, 64)
		open, _ := strconv.ParseFloat(r[1], 64)
		high, _ := strconv.ParseFloat(r[2], 64)
		low, _ := strconv.ParseFloat(r[3], 64)
		cls, _ := strconv.ParseFloat(r[4], 64)
		vol, _ := strconv.ParseFloat(r[5], 64)
		candles = append(candles, shm.Candle{
			Open: open, High: high, Low: low, Close: cls, Volume: vol, TsMs: ts,
		})
	}

	atr := wilderATR(candles, 14)

	f.state.mu.Lock()
	f.state.Candles = candles
	f.state.ATR14 = atr
	f.state.mu.Unlock()

	log.Printf("[Feed] OHLCV refreshed: %d candles ATR14=%.4f", len(candles), atr)
	return nil
}

// fetchAux mengambil OI, LSR, dan Funding Rate.
// FIX: setiap field sekarang di-parse by name, bukan random dari map iteration.
func (f *Feed) fetchAux(symbol string) error {
	// ── Open Interest ─────────────────────────────────────────────────────────
	// Bybit response: {"result":{"list":[{"openInterest":"2847291.00","timestamp":"1748xxx"}]}}
	// BUG LAMA: fetchSingleFloat ambil field pertama dari map (random order di Go) →
	//   kadang dapet "timestamp" (1.748e12) bukan "openInterest" (2.847e6)
	// FIX: fetchSpecificFloat("openInterest") → always correct field
	oiURL := fmt.Sprintf("%s/v5/market/open-interest?category=linear&symbol=%s&intervalTime=5min&limit=1",
		bybitRESTMain, symbol)
	if oi, err := fetchSpecificFloat(f.client, oiURL, "openInterest"); err == nil && oi > 0 {
		// Sanity check: OI dalam contracts tidak akan > 1 miliar untuk crypto biasa
		// Jika > 1e10 kemungkinan besar timestamp terselip
		if oi < 1e10 {
			f.state.mu.Lock()
			f.state.OI = oi
			f.state.mu.Unlock()
			log.Printf("[OI] %s oi=%.2f (contracts)", symbol, oi)
		} else {
			log.Printf("[OI] %s SKIP suspicious value=%.0f (looks like timestamp)", symbol, oi)
		}
	}

	// ── Long/Short Ratio ──────────────────────────────────────────────────────
	lsrURL := fmt.Sprintf("%s/v5/market/account-ratio?category=linear&symbol=%s&period=5min&limit=1",
		bybitRESTMain, symbol)
	if buy, sell, err := fetchLSR(f.client, lsrURL); err == nil && sell > 0 {
		lsr := buy / sell
		f.state.mu.Lock()
		f.state.LSR = lsr
		f.state.mu.Unlock()
		log.Printf("[WHALE] %s LSR=%.4f bias=%s", symbol, lsr, lsrBiasLabel(lsr))
	}

	// ── Funding Rate ──────────────────────────────────────────────────────────
	// Bybit response: {"result":{"list":[{"fundingRate":"0.0001","fundingRateTimestamp":"..."}]}}
	frURL := fmt.Sprintf("%s/v5/market/funding/history?category=linear&symbol=%s&limit=1",
		bybitRESTMain, symbol)
	if fr, err := fetchSpecificFloat(f.client, frURL, "fundingRate"); err == nil {
		f.state.mu.Lock()
		f.state.FundingRate = fr
		f.state.mu.Unlock()
	}

	return nil
}

// lsrBiasLabel returns a human-readable label for log output.
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

func (f *Feed) flushToSHM(symbol string) {
	f.state.mu.RLock()
	s := f.state
	f.state.mu.RUnlock()

	if s.Price <= 0 || len(s.Candles) == 0 {
		return
	}

	var sym [16]byte
	copy(sym[:], symbol)

	md := &shm.MarketData{
		Symbol:         sym,
		Candles:        s.Candles,
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

	f.bridge.WriteMarket(md)
	atomic.AddUint64(&flushSeq, 1)
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

// fetchSpecificFloat mengambil satu field by name dari Bybit REST response.
//
// FIX menggantikan fetchSingleFloat yang lama. fetchSingleFloat yang lama mengabaikan
// parameter fieldName (pakai `_`) dan iterate map dengan random order — kadang
// mendapatkan field "timestamp" (nilai ~1.748e12) alih-alih "openInterest" (~2.8e6).
// Hasilnya OI tampil sebagai "1779.78B" di dashboard.
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

	// Bybit selalu mengirim angka sebagai string JSON
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		// Mungkin angka langsung (bukan string)
		var f float64
		if err2 := json.Unmarshal(raw, &f); err2 != nil {
			return 0, fmt.Errorf("cannot parse field '%s': %w", fieldName, err)
		}
		return f, nil
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

// UpdateMacro mengupdate field macro Absurdist (dipanggil dari goroutine terpisah).
func (f *Feed) UpdateMacro(usdtDelta, kimchi, whaleInflow, longLiq, shortLiq float64) {
	f.state.mu.Lock()
	f.state.USDTDeltaPct = usdtDelta
	f.state.KimchiPct = kimchi
	f.state.WhaleInflowUSD = whaleInflow
	f.state.LongLiq1h = longLiq
	f.state.ShortLiq1h = shortLiq
	f.state.mu.Unlock()
}
