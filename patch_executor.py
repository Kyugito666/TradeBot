import re

with open("go-engine/exchange/bybit/executor.go", "r") as f:
    code = f.read()

# Replacement 1: Add wsClient to Executor struct
code = re.sub(
    r"type Executor struct \{.*?\}",
    "type Executor struct {\n\tcfg      Config\n\tclient   *http.Client\n\tbase     string\n\tbalCache balanceCache\n\twsClient *WSClient\n}",
    code,
    flags=re.DOTALL
)

# Replacement 2: Initialize wsClient in New()
new_func = """func New(cfg Config) *Executor {
	base := mainnetBase
	if cfg.Testnet {
		base = testnetBase
	}
	e := &Executor{
		cfg: cfg,
		client: &http.Client{
			Timeout:   10 * time.Second,
		},
		base: base,
	}
	e.balCache.ttl = balanceCacheTTL

	e.wsClient = NewWSClient(cfg.Testnet, cfg.APIKey, cfg.APISecret)
	if err := e.wsClient.Connect(context.Background()); err != nil {
		log.Printf("[Executor] WARNING: WS Connect failed: %v", err)
	}

	return e
}"""

code = re.sub(
    r"func New\(cfg Config\) \*Executor \{.*?return e\n\}",
    new_func,
    code,
    flags=re.DOTALL
)

# Replacement 3: Update placeOrder to use WebSocket
place_order_ws = """func (e *Executor) placeOrder(ctx context.Context, req OrderRequest, size float64) (string, error) {
	reqID := fmt.Sprintf("order_%d", time.Now().UnixNano())
	args := []interface{}{
		map[string]interface{}{
			"category":    "linear",
			"symbol":      bybitSymbol(req.Symbol),
			"side":        req.Side,
			"orderType":   "Limit",
			"qty":         fmt.Sprintf("%.4f", size),
			"price":       fmt.Sprintf("%.4f", req.Entry),
			"timeInForce": "GTC",
			"positionIdx": 0,
			"takeProfit":  fmt.Sprintf("%.4f", req.TakeProfit),
			"stopLoss":    fmt.Sprintf("%.4f", req.StopLoss),
			"tpTriggerBy": "LastPrice",
			"slTriggerBy": "LastPrice",
			"tpslMode":    "Full",
			"orderLinkId": reqID,
		},
	}

	cb, err := e.wsClient.SendRequest("order.create", args, reqID)
	if err != nil {
		return "", err
	}

	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case resp := <-cb:
		var result struct {
			RetCode int    `json:"retCode"`
			RetMsg  string `json:"retMsg"`
			Data    struct {
				OrderId string `json:"orderId"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			return "", err
		}
		if result.RetCode != 0 {
			return "", fmt.Errorf("bybit WS API %d: %s", result.RetCode, result.RetMsg)
		}
		return result.Data.OrderId, nil
	case <-time.After(5 * time.Second):
		return "", fmt.Errorf("websocket order creation timeout")
	}
}"""

code = re.sub(
    r"func \(e \*Executor\) placeOrder.*?return result\.Result\.OrderID, nil\n\}",
    place_order_ws,
    code,
    flags=re.DOTALL
)

with open("go-engine/exchange/bybit/executor.go", "w") as f:
    f.write(code)
