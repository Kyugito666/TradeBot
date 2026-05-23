package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"tradebot/data-gateway/cache"
	"tradebot/data-gateway/exchange/bybit"
)

type ErrorResponse struct {
	Error string `json:"error"`
}

func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		http.Error(w, `{"error":"JSON serialization failed"}`, http.StatusInternalServerError)
	}
}

func respondError(w http.ResponseWriter, code int, message string) {
	respondJSON(w, code, ErrorResponse{Error: message})
}

func HealthCheckHandler(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"message": "Go Data Gateway is active",
	})
}

func FetchOHLCVHandler(w http.ResponseWriter, r *http.Request) {
	symbol := r.URL.Query().Get("symbol")
	if symbol == "" {
		respondError(w, http.StatusBadRequest, "Parameter 'symbol' diwajibkan")
		return
	}

	interval := r.URL.Query().Get("interval")
	if interval == "" {
		interval = "5m"
	}

	limit := 100
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	// 1. Cek Cache
	cacheKey := fmt.Sprintf("ohlcv_%s_%s_%d", symbol, interval, limit)
	if cached, found := cache.GlobalCache.Get(cacheKey); found {
		respondJSON(w, http.StatusOK, cached)
		return
	}

	// 2. Fetch ke CEX jika Cache Miss
	candles, err := bybit.FetchOHLCV(symbol, interval, limit)
	if err != nil {
		log.Printf("[API] OHLCV Error: %v", err)
		respondError(w, http.StatusBadGateway, "Gagal menarik data dari exchange")
		return
	}

	response := map[string]interface{}{
		"symbol":   symbol,
		"interval": interval,
		"limit":    limit,
		"candles":  candles,
	}

	// 3. Simpan ke Cache dengan TTL 5 Detik
	cache.GlobalCache.Set(cacheKey, response, 5*time.Second)
	respondJSON(w, http.StatusOK, response)
}

func FetchOpenInterestHandler(w http.ResponseWriter, r *http.Request) {
	symbol := r.URL.Query().Get("symbol")
	if symbol == "" {
		respondError(w, http.StatusBadRequest, "Parameter 'symbol' diwajibkan")
		return
	}

	cacheKey := fmt.Sprintf("oi_%s", symbol)
	if cached, found := cache.GlobalCache.Get(cacheKey); found {
		respondJSON(w, http.StatusOK, cached)
		return
	}

	oi, err := bybit.FetchOpenInterest(symbol)
	if err != nil {
		log.Printf("[API] OI Error: %v", err)
		respondError(w, http.StatusBadGateway, "Gagal menarik Open Interest")
		return
	}

	response := map[string]interface{}{
		"symbol": symbol,
		"oi":     oi,
	}

	// OI cukup dicache selama 10 detik, karena fluktuasinya lambat
	cache.GlobalCache.Set(cacheKey, response, 10*time.Second)
	respondJSON(w, http.StatusOK, response)
}

func FetchLSRHandler(w http.ResponseWriter, r *http.Request) {
	symbol := r.URL.Query().Get("symbol")
	if symbol == "" {
		respondError(w, http.StatusBadRequest, "Parameter 'symbol' diwajibkan")
		return
	}

	period := r.URL.Query().Get("period")
	if period == "" {
		period = "5min"
	}

	cacheKey := fmt.Sprintf("lsr_%s_%s", symbol, period)
	if cached, found := cache.GlobalCache.Get(cacheKey); found {
		respondJSON(w, http.StatusOK, cached)
		return
	}

	buyRatio, shortRatio, lsr, err := bybit.FetchWhaleRatio(symbol, period)
	if err != nil {
		log.Printf("[API] LSR Error: %v", err)
		respondError(w, http.StatusBadGateway, "Gagal menarik rasio LSR")
		return
	}

	response := map[string]interface{}{
		"symbol":      symbol,
		"period":      period,
		"long_ratio":  buyRatio,
		"short_ratio": shortRatio,
		"lsr":         lsr,
	}

	cache.GlobalCache.Set(cacheKey, response, 10*time.Second)
	respondJSON(w, http.StatusOK, response)
}