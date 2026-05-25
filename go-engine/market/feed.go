// go-engine/market/feed.go
//
// Market data feed — pulls live data from exchange and packages it
// as MarketData for SHM. Runs three concurrent goroutines:
//   • wsTickerLoop  : WebSocket real-time price (sub-millisecond latency)
//   • restOHLCVLoop : REST candles refresh every loop_interval seconds
//   • restAuxLoop   : REST OI, LSR, funding rate refresh every ~30s

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
	bybitWSMain  = "wss://stream.bytick.com/v5/public/linear"
	bybitRESTMain = "https://api.bytick.com"
	pingInterval = 20 * time.Second
)

// State is shared between the three goroutines and is read-merged on each SHM write
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

	// Macro (Go fetches these from public APIs — Absurdist agent input)
	USDTDeltaPct   float64
	KimchiPct      float64
	WhaleInflowUSD float64
	LongLiq1h      float64
	ShortLiq1h     float64

	// Sentiment (Go RSS goroutine — Linguist agent input)
	SentimentScore float32
	NewsCount      uint32

	// Meta
	Symbol string
}

// Feed orchestrates all data sources and writes to SHM on every price update
type Feed struct {
	state   State
	bridge  *shm.Bridge
	client  *http.Client
	ohlcvTF string // e.g. "5"  (Bybit interval minutes)
	limit   int    // candle count
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

// Run starts all goroutines; blocks until ctx is cancelled
func (f *Feed) Run(ctx context.Context) {
	sym := f.state.Symbol
	log.Printf("[Feed] Starting for %s tf=%s limit=%d", sym, f.ohlcvTF, f.limit)

	// Prime OHLCV synchronously before starting WS (Rust needs candles on first tick)
	if err := f.fetchOHLCV(sym); err != nil {
		log.Printf("[Feed] Initial OHLCV fetch failed: %v", err)
	}
	_ = f.fetchAux(sym)

	var wg sync.WaitGroup

	wg.Add(1)
	go func() {
		defer wg.Done()
		f.wsTickerLoop(ctx, sym)
	}()

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

	// Ping goroutine
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
			LastPrice  string `json:"lastPrice"`
			Bid1Price  string `json:"bid1Price"`
			Ask1Price  string `json:"ask1Price"`
		}
		if err := json.Unmarshal(raw["data"], &data); err != nil {
			continue
		}

		price, _ := strconv.ParseFloat(data.LastPrice, 64)
		bid, _   := strconv.ParseFloat(data.Bid1Price, 64)
		ask, _   := strconv.ParseFloat(data.Ask1Price, 64)

		if price <= 0 {
			continue
		}

		f.state.mu.Lock()
		f.state.Price = price
		if bid > 0 { f.state.Bid = bid }
		if ask > 0 { f.state.Ask = ask }
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
	// Bybit returns newest-first → reverse for Rust (oldest-first)
	candles := make([]shm.Candle, 0, len(rows))
	for i := len(rows) - 1; i >= 0; i-- {
		r := rows[i]
		if len(r) < 6 { continue }
		ts,   _ := strconv.ParseInt(r[0], 10, 64)
		open, _ := strconv.ParseFloat(r[1], 64)
		high, _ := strconv.ParseFloat(r[2], 64)
		low,  _ := strconv.ParseFloat(r[3], 64)
		cls,  _ := strconv.ParseFloat(r[4], 64)
		vol,  _ := strconv.ParseFloat(r[5], 64)
		candles = append(candles, shm.Candle{
			Open: open, High: high, Low: low, Close: cls, Volume: vol, TsMs: ts,
		})
	}

	atr := wilderATR(candles, 14)

	f.state.mu.Lock()
	f.state.Candles = candles
	f.state.ATR14   = atr
	f.state.mu.Unlock()

	log.Printf("[Feed] OHLCV refreshed: %d candles ATR14=%.4f", len(candles), atr)
	return nil
}

func (f *Feed) fetchAux(symbol string) error {
	// Open Interest
	oiURL := fmt.Sprintf("%s/v5/market/open-interest?category=linear&symbol=%s&intervalTime=5min&limit=1", bybitRESTMain, symbol)
	if oi, err := fetchSingleFloat(f.client, oiURL, "result.list.0.openInterest"); err == nil {
		f.state.mu.Lock(); f.state.OI = oi; f.state.mu.Unlock()
	}

	// Long/Short Ratio
	lsrURL := fmt.Sprintf("%s/v5/market/account-ratio?category=linear&symbol=%s&period=5min&limit=1", bybitRESTMain, symbol)
	if buy, sell, err := fetchLSR(f.client, lsrURL); err == nil && sell > 0 {
		f.state.mu.Lock(); f.state.LSR = buy / sell; f.state.mu.Unlock()
	}

	// Funding Rate
	frURL := fmt.Sprintf("%s/v5/market/funding/history?category=linear&symbol=%s&limit=1", bybitRESTMain, symbol)
	if fr, err := fetchSingleFloat(f.client, frURL, "result.list.0.fundingRate"); err == nil {
		f.state.mu.Lock(); f.state.FundingRate = fr; f.state.mu.Unlock()
	}

	return nil
}

// ── SHM Flush ─────────────────────────────────────────────────────────────────

var flushSeq uint64 // monotonic frame counter (not the seqlock seq)

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
		Symbol:          sym,
		Candles:         s.Candles,
		Price:           s.Price,
		Bid:             s.Bid,
		Ask:             s.Ask,
		OI:              s.OI,
		LSR:             s.LSR,
		ATR14:           s.ATR14,
		FundingRate:     s.FundingRate,
		USDTDeltaPct:    s.USDTDeltaPct,
		KimchiPct:       s.KimchiPct,
		WhaleInflowUSD:  s.WhaleInflowUSD,
		LongLiq1h:       s.LongLiq1h,
		ShortLiq1h:      s.ShortLiq1h,
		SentimentScore:  s.SentimentScore,
		NewsCount:       s.NewsCount,
		TsMs:            time.Now().UnixMilli(),
	}

	f.bridge.WriteMarket(md)
	atomic.AddUint64(&flushSeq, 1)
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

// wilderATR computes Wilder-smoothed ATR matching the Rust implementation
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
	if len(trs) == 0 { return 0 }
	seedN := period
	if seedN > len(trs) { seedN = len(trs) }
	var atr float64
	for _, v := range trs[:seedN] { atr += v }
	atr /= float64(seedN)
	alpha := 1.0 / float64(period)
	for _, v := range trs[seedN:] {
		atr = atr*(1-alpha) + v*alpha
	}
	return atr
}

// fetchSingleFloat is a quick helper to pull one numeric value from a Bybit JSON path
func fetchSingleFloat(client *http.Client, url, _ string) (float64, error) {
	resp, err := client.Get(url)
	if err != nil { return 0, err }
	defer resp.Body.Close()
	var m map[string]json.RawMessage
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &m); err != nil { return 0, err }
	// Generic drill-down: result → list → [0] → first numeric field
	var result map[string]json.RawMessage
	if err := json.Unmarshal(m["result"], &result); err != nil { return 0, err }
	var list []map[string]json.RawMessage
	if err := json.Unmarshal(result["list"], &list); err != nil { return 0, err }
	if len(list) == 0 { return 0, fmt.Errorf("empty list") }
	for _, raw := range list[0] {
		var s string
		if err := json.Unmarshal(raw, &s); err != nil { continue }
		if v, err := strconv.ParseFloat(s, 64); err == nil && v != 0 {
			return v, nil
		}
	}
	return 0, fmt.Errorf("no numeric field found")
}

func fetchLSR(client *http.Client, url string) (buy, sell float64, err error) {
	resp, err := client.Get(url)
	if err != nil { return }
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
	if err = json.Unmarshal(body, &payload); err != nil { return }
	if len(payload.Result.List) == 0 { err = fmt.Errorf("empty"); return }
	buy,  _ = strconv.ParseFloat(payload.Result.List[0].BuyRatio, 64)
	sell, _ = strconv.ParseFloat(payload.Result.List[0].SellRatio, 64)
	return
}

// UpdateSentiment is called by the RSS goroutine in main.go
func (f *Feed) UpdateSentiment(score float32, count uint32) {
	f.state.mu.Lock()
	f.state.SentimentScore = score
	f.state.NewsCount      = count
	f.state.mu.Unlock()
}

// UpdateMacro updates the Absurdist macro fields (called from separate goroutines)
func (f *Feed) UpdateMacro(usdtDelta, kimchi, whaleInflow, longLiq, shortLiq float64) {
	f.state.mu.Lock()
	f.state.USDTDeltaPct   = usdtDelta
	f.state.KimchiPct      = kimchi
	f.state.WhaleInflowUSD = whaleInflow
	f.state.LongLiq1h      = longLiq
	f.state.ShortLiq1h     = shortLiq
	f.state.mu.Unlock()
}
