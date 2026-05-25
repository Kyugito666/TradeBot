package bybit

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// KUNCI UTAMA: Kita pakai bytick.com lagi untuk nembus blokir ISP Indonesia
const baseURL = "https://api.bytick.com"

type OIPayload struct {
	RetCode int `json:"retCode"`
	Result  struct {
		List []struct {
			OpenInterest string `json:"openInterest"`
		} `json:"list"`
	} `json:"result"`
}

type LSRPayload struct {
	RetCode int `json:"retCode"`
	Result  struct {
		List []struct {
			BuyRatio  string `json:"buyRatio"`
			SellRatio string `json:"sellRatio"`
		} `json:"list"`
	} `json:"result"`
}

func FetchOpenInterest(symbol string) (float64, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("%s/v5/market/tickers?category=linear&symbol=%s", baseURL, symbol)

	resp, err := client.Get(url)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()

	var payload OIPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, err
	}

	if payload.RetCode != 0 || len(payload.Result.List) == 0 {
		return 0, fmt.Errorf("API error %d", payload.RetCode)
	}

	oi, err := strconv.ParseFloat(payload.Result.List[0].OpenInterest, 64)
	if err != nil {
		return 0, err
	}

	return oi, nil
}

func FetchWhaleRatio(symbol string, period string) (float64, float64, float64, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("%s/v5/market/account-ratio?category=linear&symbol=%s&period=%s", baseURL, symbol, period)

	resp, err := client.Get(url)
	if err != nil {
		return 0, 0, 0, err
	}
	defer resp.Body.Close()

	var payload LSRPayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return 0, 0, 0, err
	}

	if payload.RetCode != 0 || len(payload.Result.List) == 0 {
		return 0, 0, 0, fmt.Errorf("API error %d", payload.RetCode)
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