package bybit

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	mainnetWSTrade = "wss://stream.bybit.com/v5/trade"
	testnetWSTrade = "wss://stream-testnet.bybit.com/v5/trade"
)

type WSClient struct {
	url       string
	apiKey    string
	apiSecret string
	conn      *websocket.Conn
	mu        sync.Mutex
	writeMu   sync.Mutex
	isClosed  bool
	
	reqCallbacks map[string]chan []byte
	cbMu         sync.Mutex
}

func NewWSClient(testnet bool, apiKey, apiSecret string) *WSClient {
	url := mainnetWSTrade
	if testnet {
		url = testnetWSTrade
	}
	return &WSClient{
		url:          url,
		apiKey:       apiKey,
		apiSecret:    apiSecret,
		reqCallbacks: make(map[string]chan []byte),
	}
}

func (w *WSClient) Connect(ctx context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, w.url, nil)
	if err != nil {
		return fmt.Errorf("websocket dial: %v", err)
	}
	w.conn = conn

	// Authenticate
	expires := time.Now().UnixMilli() + 10000
	val := fmt.Sprintf("GET/realtime%d", expires)
	mac := hmac.New(sha256.New, []byte(w.apiSecret))
	mac.Write([]byte(val))
	signature := hex.EncodeToString(mac.Sum(nil))

	authReq := map[string]interface{}{
		"reqId": "auth",
		"op":    "auth",
		"args":  []interface{}{w.apiKey, expires, signature},
	}

	if err := w.send(authReq); err != nil {
		return fmt.Errorf("auth error: %v", err)
	}

	// Simple read to check auth
	_, message, err := conn.ReadMessage()
	if err != nil {
		return fmt.Errorf("auth read error: %v", err)
	}
	log.Printf("[Bybit WS] Auth response: %s", string(message))

	go w.readLoop()
	go w.pingLoop()

	return nil
}

func (w *WSClient) send(msg interface{}) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	if w.conn == nil {
		return fmt.Errorf("websocket not connected")
	}
	return w.conn.WriteJSON(msg)
}

func (w *WSClient) SendRequest(op string, args []interface{}, reqID string) (<-chan []byte, error) {
	cb := make(chan []byte, 1)
	
	w.cbMu.Lock()
	w.reqCallbacks[reqID] = cb
	w.cbMu.Unlock()

	req := map[string]interface{}{
		"reqId": reqID,
		"header": map[string]string{
			"X-BAPI-TIMESTAMP": fmt.Sprintf("%d", time.Now().UnixMilli()),
			"X-BAPI-RECV-WINDOW": "5000",
		},
		"op":    op,
		"args":  args,
	}
	
	if err := w.send(req); err != nil {
		w.cbMu.Lock()
		delete(w.reqCallbacks, reqID)
		w.cbMu.Unlock()
		return nil, err
	}
	
	return cb, nil
}

func (w *WSClient) readLoop() {
	for {
		w.mu.Lock()
		conn := w.conn
		isClosed := w.isClosed
		w.mu.Unlock()

		if isClosed || conn == nil {
			break
		}

		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[Bybit WS] Read error: %v. Reconnecting...", err)
			w.reconnect()
			return
		}

		var frame struct {
			ReqID string `json:"reqId"`
			Op    string `json:"op"`
			RetCode int  `json:"retCode"`
			RetMsg  string `json:"retMsg"`
		}
		if err := json.Unmarshal(message, &frame); err == nil {
			if frame.ReqID != "" {
				w.cbMu.Lock()
				if cb, ok := w.reqCallbacks[frame.ReqID]; ok {
					cb <- message
					delete(w.reqCallbacks, frame.ReqID)
				}
				w.cbMu.Unlock()
			}
		}
	}
}

func (w *WSClient) pingLoop() {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		w.mu.Lock()
		isClosed := w.isClosed
		w.mu.Unlock()
		
		if isClosed {
			return
		}

		w.send(map[string]interface{}{"reqId": "ping", "op": "ping"})
	}
}

func (w *WSClient) reconnect() {
	w.mu.Lock()
	if w.conn != nil {
		w.conn.Close()
		w.conn = nil
	}
	w.mu.Unlock()
	
	for {
		err := w.Connect(context.Background())
		if err == nil {
			log.Printf("[Bybit WS] Reconnected successfully")
			break
		}
		log.Printf("[Bybit WS] Reconnect failed: %v, retrying in 5s...", err)
		time.Sleep(5 * time.Second)
	}
}

func (w *WSClient) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.isClosed = true
	if w.conn != nil {
		w.conn.Close()
		w.conn = nil
	}
}
