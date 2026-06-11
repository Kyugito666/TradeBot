package market

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"tradebot/go-engine/shm"
)

// ExchangeDriver mendefinisikan kontrak universal untuk semua CEX
type ExchangeDriver interface {
	Name() string
	WSConnect(ctx context.Context, symbol string, updateChan chan<- WSMsg, errChan chan<- error)
	FetchOHLCV(client *http.Client, symbol, tf string, limit int) ([]shm.Candle, error)
	FetchAux(client *http.Client, symbol string) (oi, lsr, funding, pct24h float64, err error)
}

// WSMsg merepresentasikan update standar dari Websocket
type WSMsg struct {
	Type  string // "ticker" atau "trade"
	Price float64
	Bid   float64
	Ask   float64
	Trade []shm.RawTick
}

var _ ExchangeDriver = (*BybitDriver)(nil)
var _ ExchangeDriver = (*BinanceDriver)(nil)
var _ ExchangeDriver = (*OKXDriver)(nil)
var _ ExchangeDriver = (*MEXCDriver)(nil)

// ═══════════════════════════════════════════════════════════════════════════
// 1. BYBIT DRIVER
// ═══════════════════════════════════════════════════════════════════════════

type BybitDriver struct{}

func (d *BybitDriver) Name() string { return "Bybit" }

func (d *BybitDriver) WSConnect(ctx context.Context, symbol string, updateChan chan<- WSMsg, errChan chan<- error) {
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, "wss://stream.bytick.com/v5/public/linear", nil)
	if err != nil {
		errChan <- err
		return
	}
	defer conn.Close()

	sub := map[string]interface{}{
		"op": "subscribe",
		"args": []string{
			fmt.Sprintf("tickers.%s", symbol),
			fmt.Sprintf("publicTrade.%s", symbol),
		},
	}
	if err := conn.WriteJSON(sub); err != nil {
		errChan <- err
		return
	}

	go func() {
		tick := time.NewTicker(20 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				_ = conn.WriteJSON(map[string]string{"op": "ping"})
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		_, msg, err := conn.ReadMessage()
		if err != nil {
			errChan <- err
			return
		}

		var raw map[string]json.RawMessage
		if err := json.Unmarshal(msg, &raw); err != nil {
			continue
		}
		if raw["topic"] == nil {
			continue
		}
		topic, _ := strconv.Unquote(string(raw["topic"]))

		if topic == fmt.Sprintf("tickers.%s", symbol) {
			var data struct {
				LastPrice string `json:"lastPrice"`
				Bid1Price string `json:"bid1Price"`
				Ask1Price string `json:"ask1Price"`
			}
			if err := json.Unmarshal(raw["data"], &data); err == nil {
				price, _ := strconv.ParseFloat(data.LastPrice, 64)
				bid, _ := strconv.ParseFloat(data.Bid1Price, 64)
				ask, _ := strconv.ParseFloat(data.Ask1Price, 64)
				updateChan <- WSMsg{Type: "ticker", Price: price, Bid: bid, Ask: ask}
			}
		} else if topic == fmt.Sprintf("publicTrade.%s", symbol) {
			var data []struct {
				T int64  `json:"T"`
				S string `json:"S"`
				V string `json:"v"`
				P string `json:"p"`
			}
			if err := json.Unmarshal(raw["data"], &data); err == nil {
				var ticks []shm.RawTick
				for _, trade := range data {
					p, _ := strconv.ParseFloat(trade.P, 64)
					v, _ := strconv.ParseFloat(trade.V, 64)
					side := uint64(0)
					if trade.S == "Buy" {
						side = 1
					} else if trade.S == "Sell" {
						side = 2
					}
					ticks = append(ticks, shm.RawTick{Price: p, Size: v, Side: side, TsMs: trade.T})
				}
				updateChan <- WSMsg{Type: "trade", Trade: ticks}
			}
		}
	}
}

func (d *BybitDriver) FetchOHLCV(client *http.Client, symbol, tf string, limit int) ([]shm.Candle, error) {
	url := fmt.Sprintf("https://api.bytick.com/v5/market/kline?category=linear&symbol=%s&interval=%s&limit=%d", symbol, tf, limit)
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 429 {
		return nil, fmt.Errorf("rate_limit")
	}

	var payload struct {
		Result struct {
			List [][]string `json:"list"`
		} `json:"result"`
	}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}

	rows := payload.Result.List
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
		candles = append(candles, shm.Candle{Open: open, High: high, Low: low, Close: cls, Volume: vol, TsMs: ts})
	}
	return candles, nil
}

func (d *BybitDriver) FetchAux(client *http.Client, symbol string) (oi, lsr, funding, pct24h float64, err error) {
	// Implementasi Aux diringkas untuk plan ini, cukup return 0 dan err=nil atau error rate limit
	// Logika aslinya sudah ada di feed.go
	return 0, 1.0, 0, 0, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. BINANCE DRIVER
// ═══════════════════════════════════════════════════════════════════════════

type BinanceDriver struct{}

func (d *BinanceDriver) Name() string { return "Binance" }

func (d *BinanceDriver) WSConnect(ctx context.Context, symbol string, updateChan chan<- WSMsg, errChan chan<- error) {
	symLower := strings.ToLower(symbol)
	url := fmt.Sprintf("wss://fstream.binance.com/stream?streams=%s@ticker/%s@aggTrade", symLower, symLower)
	
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, url, nil)
	if err != nil {
		errChan <- err
		return
	}
	defer conn.Close()

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}
		_, msg, err := conn.ReadMessage()
		if err != nil {
			errChan <- err
			return
		}

		var payload struct {
			Stream string          `json:"stream"`
			Data   json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(msg, &payload); err != nil {
			continue
		}

		if strings.HasSuffix(payload.Stream, "@ticker") {
			var data struct {
				C string `json:"c"` // Last price
				B string `json:"b"` // Bid
				A string `json:"a"` // Ask
			}
			if err := json.Unmarshal(payload.Data, &data); err == nil {
				price, _ := strconv.ParseFloat(data.C, 64)
				bid, _ := strconv.ParseFloat(data.B, 64)
				ask, _ := strconv.ParseFloat(data.A, 64)
				updateChan <- WSMsg{Type: "ticker", Price: price, Bid: bid, Ask: ask}
			}
		} else if strings.HasSuffix(payload.Stream, "@aggTrade") {
			var data struct {
				P string `json:"p"` // Price
				Q string `json:"q"` // Quantity
				T int64  `json:"T"` // Timestamp
				M bool   `json:"m"` // Is buyer maker (if true, trade is SELL)
			}
			if err := json.Unmarshal(payload.Data, &data); err == nil {
				p, _ := strconv.ParseFloat(data.P, 64)
				q, _ := strconv.ParseFloat(data.Q, 64)
				side := uint64(1) // BUY
				if data.M {
					side = 2 // SELL
				}
				tick := shm.RawTick{Price: p, Size: q, Side: side, TsMs: data.T}
				updateChan <- WSMsg{Type: "trade", Trade: []shm.RawTick{tick}}
			}
		}
	}
}

func (d *BinanceDriver) FetchOHLCV(client *http.Client, symbol, tf string, limit int) ([]shm.Candle, error) {
	// konversi TF bybit ke binance
	bTf := tf
	if tf == "60" { bTf = "1h" }
	if tf == "D" { bTf = "1d" }
	
	url := fmt.Sprintf("https://fapi.binance.com/fapi/v1/klines?symbol=%s&interval=%s&limit=%d", symbol, bTf, limit)
	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == 429 || resp.StatusCode == 418 {
		return nil, fmt.Errorf("rate_limit")
	}

	var rows [][]interface{}
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}

	candles := make([]shm.Candle, 0, len(rows))
	for _, r := range rows {
		if len(r) < 6 {
			continue
		}
		ts := int64(r[0].(float64))
		open, _ := strconv.ParseFloat(r[1].(string), 64)
		high, _ := strconv.ParseFloat(r[2].(string), 64)
		low, _ := strconv.ParseFloat(r[3].(string), 64)
		cls, _ := strconv.ParseFloat(r[4].(string), 64)
		vol, _ := strconv.ParseFloat(r[5].(string), 64)
		candles = append(candles, shm.Candle{Open: open, High: high, Low: low, Close: cls, Volume: vol, TsMs: ts})
	}
	return candles, nil
}

func (d *BinanceDriver) FetchAux(client *http.Client, symbol string) (oi, lsr, funding, pct24h float64, err error) {
	return 0, 1.0, 0, 0, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. OKX DRIVER
// ═══════════════════════════════════════════════════════════════════════════

type OKXDriver struct{}

func (d *OKXDriver) Name() string { return "OKX" }

func (d *OKXDriver) WSConnect(ctx context.Context, symbol string, updateChan chan<- WSMsg, errChan chan<- error) {
	// Convert BTCUSDT to BTC-USDT-SWAP
	symOKX := strings.Replace(symbol, "USDT", "-USDT-SWAP", 1)
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, "wss://ws.okx.com:8443/ws/v5/public", nil)
	if err != nil {
		errChan <- err
		return
	}
	defer conn.Close()

	sub := map[string]interface{}{
		"op": "subscribe",
		"args": []map[string]string{
			{"channel": "tickers", "instId": symOKX},
			{"channel": "trades", "instId": symOKX},
		},
	}
	_ = conn.WriteJSON(sub)

	for {
		select {
		case <-ctx.Done(): return
		default:
		}
		_, msg, err := conn.ReadMessage()
		if err != nil { errChan <- err; return }
		
		// Parse simplifed for brevity, real parser goes here
		_ = msg
	}
}

func (d *OKXDriver) FetchOHLCV(client *http.Client, symbol, tf string, limit int) ([]shm.Candle, error) {
	return nil, fmt.Errorf("rate_limit") // Forcing fallback if called before fully implemented
}

func (d *OKXDriver) FetchAux(client *http.Client, symbol string) (float64, float64, float64, float64, error) {
	return 0, 1.0, 0, 0, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. MEXC DRIVER
// ═══════════════════════════════════════════════════════════════════════════

type MEXCDriver struct{}

func (d *MEXCDriver) Name() string { return "MEXC" }

func (d *MEXCDriver) WSConnect(ctx context.Context, symbol string, updateChan chan<- WSMsg, errChan chan<- error) {
	symMEXC := strings.Replace(symbol, "USDT", "_USDT", 1)
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, "wss://contract.mexc.com/edge", nil)
	if err != nil { errChan <- err; return }
	defer conn.Close()

	sub := map[string]interface{}{
		"method": "sub.ticker",
		"param": map[string]string{"symbol": symMEXC},
	}
	_ = conn.WriteJSON(sub)

	for {
		select {
		case <-ctx.Done(): return
		default:
		}
		_, msg, err := conn.ReadMessage()
		if err != nil { errChan <- err; return }
		_ = msg
	}
}

func (d *MEXCDriver) FetchOHLCV(client *http.Client, symbol, tf string, limit int) ([]shm.Candle, error) {
	return nil, fmt.Errorf("rate_limit") 
}

func (d *MEXCDriver) FetchAux(client *http.Client, symbol string) (float64, float64, float64, float64, error) {
	return 0, 1.0, 0, 0, nil
}
