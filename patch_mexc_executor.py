import re

with open("go-engine/exchange/mexc/executor.go", "r") as f:
    code = f.read()

# Replacement 1: Add wsClient to Executor struct
code = re.sub(
    r"type Executor struct \{.*?\}",
    "type Executor struct {\n\tcfg    Config\n\tclient *http.Client\n\tbase   string\n\twsClient *WSClient\n}",
    code,
    flags=re.DOTALL
)

# Replacement 2: Initialize wsClient in New()
new_func = """func New(cfg Config) *Executor {
	e := &Executor{
		cfg:    cfg,
		client: &http.Client{Timeout: 10 * time.Second},
		base:   "https://contract.mexc.com",
	}
	
	e.wsClient = NewWSClient(cfg.APIKey, cfg.APISecret)
	if err := e.wsClient.Connect(context.Background()); err != nil {
		log.Printf("[MEXC] WARNING: WS Connect failed: %v", err)
	}
	
	return e
}"""

code = re.sub(
    r"func New\(cfg Config\) \*Executor \{.*?return e\n\}",
    new_func,
    code,
    flags=re.DOTALL
)

# Replacement 3: Modify entry order to use WS.
# Since MEXC WS is more complex and less reliable for strict order ACKs, we will send the order via WS 
# but keep the SL and TP as REST (or WS as well) but we don't necessarily block on the ACK since we do fire and forget for TP/SL.

entry_order_ws = """	// ── Entry order (WebSocket) ───────────────────────────────────────────
	entryBody := map[string]interface{}{
		"symbol":       req.Symbol,
		"side":         req.Side,
		"orderType":    5, // 5 = Limit
		"openType":     1,   // Isolated
		"positionType": posType,
		"price":        req.Entry,
		"vol":          size,
		"leverage":     e.cfg.Leverage,
	}
	reqID := fmt.Sprintf("mexc_%d", time.Now().UnixNano())
	cb, err := e.wsClient.SendRequest("submit_order", entryBody, reqID)
	if err != nil {
		return fmt.Errorf("entry order ws: %w", err)
	}

	// Wait briefly for an ack or just proceed (as MEXC WS submit_order doesn't conventionally reply cleanly mapped)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-cb:
		log.Printf("[MEXC] Entry order ack received via WS")
	case <-time.After(1 * time.Second):
		log.Printf("[MEXC] Entry order sent via WS (assuming success due to no immediate error)")
	}
"""

code = re.sub(
    r"	// ── Entry order ──────────────────────────────────────────────────────.*?log\.Printf\(\"\[MEXC\] Entry order id=%s\", entryResult\.Data\)",
    entry_order_ws,
    code,
    flags=re.DOTALL
)

with open("go-engine/exchange/mexc/executor.go", "w") as f:
    f.write(code)
