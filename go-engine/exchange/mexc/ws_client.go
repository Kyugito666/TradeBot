package mexc

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

const mexcWSTrade = "wss://contract.mexc.com/ws"

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

func NewWSClient(apiKey, apiSecret string) *WSClient {
	return &WSClient{
		url:          mexcWSTrade,
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
		return fmt.Errorf("mexc websocket dial: %v", err)
	}
	w.conn = conn

	ts := time.Now().UnixMilli()
	raw := w.apiKey + fmt.Sprintf("%d", ts)
	mac := hmac.New(sha256.New, []byte(w.apiSecret))
	mac.Write([]byte(raw))
	signature := hex.EncodeToString(mac.Sum(nil))

	authReq := map[string]interface{}{
		"method": "login",
		"param": map[string]interface{}{
			"apiKey":    w.apiKey,
			"reqTime":   ts,
			"signature": signature,
		},
	}

	if err := w.send(authReq); err != nil {
		return fmt.Errorf("mexc auth error: %v", err)
	}

	go w.readLoop()
	go w.pingLoop()

	return nil
}

func (w *WSClient) send(msg interface{}) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	if w.conn == nil {
		return fmt.Errorf("mexc websocket not connected")
	}
	return w.conn.WriteJSON(msg)
}

func (w *WSClient) SendRequest(method string, params map[string]interface{}, reqID string) (<-chan []byte, error) {
	cb := make(chan []byte, 1)
	
	w.cbMu.Lock()
	w.reqCallbacks[reqID] = cb
	w.cbMu.Unlock()

	req := map[string]interface{}{
		"method": method,
		"param":  params,
	}
	// Note: MEXC WS doesn't conventionally use reqId in the request directly for order submit, 
	// but we can inject it or handle responses globally if unsupported. 
	// To be safe, we add an external identifier if possible.
	
	if err := w.send(req); err != nil {
		w.cbMu.Lock()
		delete(w.reqCallbacks, reqID)
		w.cbMu.Unlock()
		return nil, err
	}
	
	// Fast track completion for fire-and-forget logic if MEXC doesn't reply cleanly to orders via WS.
	// For production we'd parse the WS stream for 'channel': 'push.personal.order'.
	
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
			log.Printf("[MEXC WS] Read error: %v. Reconnecting...", err)
			w.reconnect()
			return
		}

		// MEXC WS responses
		var frame map[string]interface{}
		if err := json.Unmarshal(message, &frame); err == nil {
			// Basic ack routing
			// Since MEXC doesn't have a standard reqId mapping, we route any successful order submit
			// We broadcast to all pending reqCallbacks or let REST handle it.
			channel, ok := frame["channel"].(string)
			if ok && channel == "push.personal.order" {
				w.cbMu.Lock()
				for id, cb := range w.reqCallbacks {
					cb <- message
					delete(w.reqCallbacks, id)
					break 
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

		w.send(map[string]interface{}{"method": "ping"})
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
			log.Printf("[MEXC WS] Reconnected successfully")
			break
		}
		log.Printf("[MEXC WS] Reconnect failed: %v, retrying in 5s...", err)
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
