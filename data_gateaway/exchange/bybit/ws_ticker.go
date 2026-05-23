package bybit

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/gorilla/websocket"

	"tradebot/data-gateway/cache"
	"tradebot/data-gateway/resolver"
)

const wsURL = "wss://stream.bytick.com/v5/public/linear"

type wsRequest struct {
	Op   string   `json:"op"`
	Args []string `json:"args"`
}

type wsTickerResponse struct {
	Topic string `json:"topic"`
	Data  struct {
		Symbol    string `json:"symbol"`
		LastPrice string `json:"lastPrice"`
	} `json:"data"`
}

// StartTickerStream menginisialisasi koneksi WebSocket persisten di background
func StartTickerStream(symbol string) {
	// Integrasi DoH resolver untuk imunitas blokir Nawala/TrustPositif
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
		NetDialContext:   resolver.NewDoHTransport().DialContext,
	}

	for {
		log.Printf("[Bybit WS] Menghubungkan ke %s untuk %s...", wsURL, symbol)
		conn, _, err := dialer.Dial(wsURL, nil)
		if err != nil {
			log.Printf("[Bybit WS] Gagal terhubung: %v. Retrying dalam 5 detik...", err)
			time.Sleep(5 * time.Second)
			continue
		}

		// Subscribe ke topic ticker spesifik koin
		topic := fmt.Sprintf("tickers.%s", symbol)
		subReq := wsRequest{
			Op:   "subscribe",
			Args: []string{topic},
		}
		
		if err := conn.WriteJSON(subReq); err != nil {
			log.Printf("[Bybit WS] Gagal subscribe: %v", err)
			conn.Close()
			continue
		}

		log.Printf("[Bybit WS] Terhubung dan subscribed ke %s", topic)

		// Mekanisme Heartbeat: Bybit memutus koneksi jika tidak ada PING dalam 20 detik
		ctx, cancel := context.WithCancel(context.Background())
		go func() {
			ticker := time.NewTicker(20 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					if err := conn.WriteJSON(map[string]string{"op": "ping"}); err != nil {
						log.Printf("[Bybit WS] Ping gagal: %v", err)
						return
					}
				case <-ctx.Done():
					return
				}
			}
		}()

		// Read loop: Memanen data stream secara real-time
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[Bybit WS] Koneksi terputus (Error: %v)", err)
				break
			}

			var resp wsTickerResponse
			// Filter cepat memastikan hanya memproses data ticker yang relevan
			if err := json.Unmarshal(message, &resp); err == nil && resp.Topic == topic {
				if resp.Data.LastPrice != "" {
					// Simpan langsung ke memori. Python API HTTP akan membaca ini secara instan
					cacheKey := fmt.Sprintf("ticker_%s", symbol)
					cache.GlobalCache.Set(cacheKey, resp.Data.LastPrice, 10*time.Second)
				}
			}
		}

		// Pembersihan sebelum inisialisasi koneksi ulang
		cancel()
		conn.Close()
		log.Println("[Bybit WS] Reconnecting dalam 3 detik...")
		time.Sleep(3 * time.Second)
	}
}