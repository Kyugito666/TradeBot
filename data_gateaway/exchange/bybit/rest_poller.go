package bybit

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

const (
	// Menggunakan endpoint alternatif bytick untuk memitigasi blokir DNS standar di beberapa region
	baseURL = "https://api.bytick.com"
)

// OIPayload merepresentasikan struktur respons Open Interest dari Bybit V5
type OIPayload struct {
	RetCode int `json:"retCode"`
	Result  struct {
		Symbol       string `json:"symbol"`
		OpenInterest string `json:"openInterest"`
	} `json:"result"`
}

// LSRPayload merepresentasikan struktur respons Long/Short Ratio dari Bybit V5
type LSRPayload struct {
	RetCode int `json:"retCode"`
	Result  struct {
		List []struct {
			Symbol    string `json:"symbol"`
			BuyRatio  string `json:"buyRatio"`
			SellRatio string `json:"sellRatio"`
		} `json:"list"`
	} `json:"result"`
}

// FetchOpenInterest menarik metrik jumlah kontrak derivatif yang belum diselesaikan
func FetchOpenInterest(symbol string) (float64, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("%s/v5/market/open-interest?category=linear&symbol=%s&intervalTime=5min", baseURL, symbol)

	resp, err := client.Get(url)
	if err != nil {
		return 0, fmt.Errorf("HTTP GET gagal: %w", err)
	}
	defer resp.Body.Close()

	var payload OIPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, fmt.Errorf("JSON decode gagal: %w", err)
	}

	if payload.RetCode != 0 {
		return 0, fmt.Errorf("Bybit API error code: %d", payload.RetCode)
	}

	oi, err := strconv.ParseFloat(payload.Result.OpenInterest, 64)
	if err != nil {
		return 0, fmt.Errorf("gagal parsing OI value: %w", err)
	}

	return oi, nil
}

// FetchWhaleRatio menarik rasio posisi Long vs Short dari top trader
func FetchWhaleRatio(symbol string, period string) (float64, float64, float64, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("%s/v5/market/account-ratio?category=linear&symbol=%s&period=%s", baseURL, symbol, period)

	resp, err := client.Get(url)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("HTTP GET gagal: %w", err)
	}
	defer resp.Body.Close()

	var payload LSRPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, 0, 0, fmt.Errorf("JSON decode gagal: %w", err)
	}

	if payload.RetCode != 0 || len(payload.Result.List) == 0 {
		return 0, 0, 0, fmt.Errorf("API error atau data kosong (Code: %d)", payload.RetCode)
	}

	data := payload.Result.List[0]
	buyRatio, _ := strconv.ParseFloat(data.BuyRatio, 64)
	sellRatio, _ := strconv.ParseFloat(data.SellRatio, 64)

	var lsr float64 = 1.0
	if sellRatio > 0 {
		lsr = buyRatio / sellRatio
	}

	return buyRatio, sellRatio, lsr, nil
}