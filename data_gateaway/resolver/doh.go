package resolver

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"time"
)

// DoHResponse merepresentasikan struktur balasan dari Cloudflare DNS JSON API
type DoHResponse struct {
	Answer []struct {
		Type int    `json:"type"`
		Data string `json:"data"`
	} `json:"Answer"`
}

// Resolve menembus sensor DNS lokal dengan meneruskan kueri lewat HTTPS (Cloudflare 1.1.1.1)
func Resolve(hostname string) (string, error) {
	req, err := http.NewRequest("GET", "https://cloudflare-dns.com/dns-query?name="+hostname+"&type=A", nil)
	if err != nil {
		return "", err
	}
	req.Header.Add("accept", "application/dns-json")

	// Timeout singkat agar fallback bisa segera dieksekusi jika DoH bermasalah
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var dohResp DoHResponse
	if err := json.NewDecoder(resp.Body).Decode(&dohResp); err != nil {
		return "", err
	}

	for _, ans := range dohResp.Answer {
		if ans.Type == 1 { // 1 = A Record (IPv4)
			return ans.Data, nil
		}
	}
	return "", fmt.Errorf("A record tidak ditemukan untuk %s", hostname)
}

// NewDoHTransport menyediakan HTTP Transport kustom yang kebal terhadap blokir DNS ISP
func NewDoHTransport() *http.Transport {
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}

	return &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}

			// Lewati resolusi jika host sudah berupa IP mentah
			if net.ParseIP(host) != nil {
				return dialer.DialContext(ctx, network, addr)
			}

			// Eksekusi resolusi DoH
			ip, err := Resolve(host)
			if err != nil {
				// Fallback senyap ke DNS standar jika DoH gagal
				return dialer.DialContext(ctx, network, addr)
			}

			// Rekonstruksi alamat target menggunakan IP bersih (SNI TLS tetap dijaga oleh Go)
			dohAddr := net.JoinHostPort(ip, port)
			return dialer.DialContext(ctx, network, dohAddr)
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}