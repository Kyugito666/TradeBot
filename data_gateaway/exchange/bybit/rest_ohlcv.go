package bybit

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"tradebot/data-gateway/resolver"
)

// KlineResponse merepresentasikan respons API Kline Bybit V5
type KlineResponse struct {
	RetCode int `json:"retCode"`
	Result  struct {
		Symbol   string     `json:"symbol"`
		Category string     `json:"category"`
		List     [][]string `json:"list"`
	} `json:"result"`
}

// Candle adalah struktur data terstandarisasi untuk konsumsi DataFrame Python
type Candle struct {
	Timestamp int64   `json:"timestamp"`
	Open      float64 `json:"open"`
	High      float64 `json:"high"`
	Low       float64 `json:"low"`
	Close     float64 `json:"close"`
	Volume    float64 `json:"volume"`
}

// mapInterval menerjemahkan string interval Python (contoh: "5m") ke format Bybit ("5")
func mapInterval(interval string) string {
	mapping := map[string]string{
		"1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
		"1h": "60", "2h": "120", "4h": "240", "D": "D", "W": "W",
	}
	if val, ok := mapping[interval]; ok {
		return val
	}
	return "5" // Default safe-fallback
}

// FetchOHLCV menarik data historis kandelar dan menormalisasinya untuk Pandas
func FetchOHLCV(symbol, interval string, limit int) ([]Candle, error) {
	// Menggunakan DoH Transport untuk imunitas terhadap pemblokiran DNS
	client := &http.Client{
		Timeout:   5 * time.Second,
		Transport: resolver.NewDoHTransport(),
	}

	bybitInterval := mapInterval(interval)
	url := fmt.Sprintf("%s/v5/market/kline?category=linear&symbol=%s&interval=%s&limit=%d",
		baseURL, symbol, bybitInterval, limit)

	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("HTTP GET kline gagal: %w", err)
	}
	defer resp.Body.Close()

	var payload KlineResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return nil, fmt.Errorf("JSON decode kline gagal: %w", err)
	}

	if payload.RetCode != 0 {
		return nil, fmt.Errorf("Bybit API error code: %d", payload.RetCode)
	}

	var candles []Candle
	listLen := len(payload.Result.List)
	
	// Bybit mengembalikan data secara descending (terbaru di index 0).
	// Pandas time-series membutuhkan urutan ascending (terlama ke terbaru).
	for i := listLen - 1; i >= 0; i-- {
		row := payload.Result.List[i]
		if len(row) < 6 {
			continue
		}

		// Parsing dengan aman, mengabaikan error minor karena struktur list Bybit statis
		ts, _ := strconv.ParseInt(row[0], 10, 64)
		open, _ := strconv.ParseFloat(row[1], 64)
		high, _ := strconv.ParseFloat(row[2], 64)
		low, _ := strconv.ParseFloat(row[3], 64)
		closePrice, _ := strconv.ParseFloat(row[4], 64)
		vol, _ := strconv.ParseFloat(row[5], 64)

		candles = append(candles, Candle{
			Timestamp: ts,
			Open:      open,
			High:      high,
			Low:       low,
			Close:     closePrice,
			Volume:    vol,
		})
	}

	return candles, nil
}