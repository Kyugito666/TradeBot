package market

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"tradebot/go-engine/shm"
)

type BacktestReq struct {
	Period int `json:"period"`
	Speed  int `json:"speed"` // ms per candle
}

// RunBacktestEngine fetches historical K-lines and streams them to SHM.
func RunBacktestEngine(period int, speed int, sym string, bridge *shm.Bridge, feed *Feed) {
	log.Printf("[Backtest] Starting backtest for %s. Period: %d days, Speed: %dms", sym, period, speed)

	// Calculate start time
	startMs := time.Now().UnixMilli() - int64(period*24*60*60*1000)
	
	url := fmt.Sprintf("https://api.bytick.com/v5/market/kline?category=linear&symbol=%s&interval=15&start=%d", sym, startMs)
	
	resp, err := http.Get(url)
	if err != nil {
		log.Printf("[Backtest] Failed to fetch historical data: %v", err)
		return
	}
	defer resp.Body.Close()

	var data struct {
		RetCode int `json:"retCode"`
		Result  struct {
			List [][]string `json:"list"`
		} `json:"result"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil || data.RetCode != 0 {
		log.Printf("[Backtest] API decode error or non-zero retCode")
		return
	}

	candles := data.Result.List
	log.Printf("[Backtest] Fetched %d candles. Starting simulation...", len(candles))

	// Bybit returns newest first, so we reverse to stream oldest first
	for i := len(candles)/2 - 1; i >= 0; i-- {
		opp := len(candles) - 1 - i
		candles[i], candles[opp] = candles[opp], candles[i]
	}

	for _, c := range candles {
		// Stop if state says not backtesting
		if !feed.IsBacktesting() {
			log.Printf("[Backtest] Aborted by user.")
			break
		}

		closePrice, _ := strconv.ParseFloat(c[4], 64)
		vol, _ := strconv.ParseFloat(c[5], 64)
		ts, _ := strconv.ParseInt(c[0], 10, 64)
		_ = vol // unused

		feed.state.mu.Lock()
		feed.state.Price = closePrice
		// store previous state to merge
		s := feed.state
		feed.state.mu.Unlock()

		var symBytes [16]byte
		copy(symBytes[:], sym)

		md := &shm.MarketData{
			Symbol:         symBytes,
			Candles:        s.Candles,
			Price:          closePrice,
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
			TsMs:           ts,
		}

		bridge.WriteMarket(md)

		time.Sleep(time.Duration(speed) * time.Millisecond)
	}

	log.Printf("[Backtest] Simulation complete.")
	feed.SetBacktesting(false)
}
