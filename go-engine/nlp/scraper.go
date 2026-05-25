// go-engine/nlp/scraper.go
//
// Port of Python nlp_engine/news_scraper.py
// ==========================================
// Scraper concurrent untuk menarik headline berita dari RSS feeds publik.
// Menggantikan asyncio+aiohttp dengan goroutines + sync.WaitGroup + net/http.
//
// Sumber: CoinTelegraph, CoinDesk, CryptoPanic, Yahoo Finance (BTC/ETH/SOL).

package nlp

import (
	"encoding/xml"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// cryptoNewsFeeds adalah daftar RSS yang di-scrape secara concurrent.
// Identik dengan CRYPTO_NEWS_FEEDS di news_scraper.py.
var cryptoNewsFeeds = []string{
	"https://cointelegraph.com/rss",
	"https://coindesk.com/arc/outboundfeeds/rss/",
	"https://cryptopanic.com/news/rss/?auth_token=PUBLIC",
	"https://finance.yahoo.com/rss/2.0/headline?s=BTC-USD",
	"https://finance.yahoo.com/rss/2.0/headline?s=ETH-USD",
}

// rssFeed adalah struktur minimal untuk meng-unmarshal RSS XML.
type rssFeed struct {
	Channel struct {
		Items []rssItem `xml:"item"`
	} `xml:"channel"`
}

// rssItem mewakili satu entri artikel dalam RSS feed.
type rssItem struct {
	Title string `xml:"title"`
	Link  string `xml:"link"`
}

// FetchLatestNews menarik headline berita dari multi-sumber secara concurrent.
// Port langsung dari async fetch_latest_news() di news_scraper.py.
//
//   symbol     : ticker contoh "BTC", "BTCUSDT", "SOLUSDT"
//   maxArticles: batas maksimum headline yang dikembalikan
//
// Returns slice of headline strings.
func FetchLatestNews(symbol string, maxArticles int) []string {
	// Bersihkan symbol: BTCUSDT → BTC (sama dengan clean_symbol di Python)
	clean := symbol
	clean = strings.ReplaceAll(clean, "USDT", "")
	clean = strings.ReplaceAll(clean, "USD", "")
	clean = strings.ToUpper(strings.TrimSpace(clean))

	keywords := []string{
		clean,
		strings.ToLower(clean),
		"crypto",
		"bitcoin",
		"market",
	}
	// Tambahkan variations untuk symbol tertentu
	switch clean {
	case "BTC":
		keywords = append(keywords, "bitcoin", "btc")
	case "ETH":
		keywords = append(keywords, "ethereum", "eth")
	case "SOL":
		keywords = append(keywords, "solana", "sol")
	case "BNB":
		keywords = append(keywords, "binance", "bnb")
	case "XRP":
		keywords = append(keywords, "ripple", "xrp")
	}

	client := &http.Client{
		Timeout: 8 * time.Second,
	}

	var (
		mu        sync.Mutex
		wg        sync.WaitGroup
		headlines []string
	)

	for _, feedURL := range cryptoNewsFeeds {
		wg.Add(1)
		go func(url string) {
			defer wg.Done()
			items, err := fetchFeed(client, url)
			if err != nil {
				log.Printf("[NLP/Scraper] Gagal fetch %s: %v", url, err)
				return
			}
			for _, item := range items {
				if containsAnyKeyword(item.Title, keywords) {
					mu.Lock()
					headlines = append(headlines, item.Title)
					mu.Unlock()
				}
			}
		}(feedURL)
	}
	wg.Wait()

	// Deduplikasi (set-like)
	seen := make(map[string]struct{}, len(headlines))
	unique := headlines[:0]
	for _, h := range headlines {
		if _, ok := seen[h]; !ok {
			seen[h] = struct{}{}
			unique = append(unique, h)
		}
	}

	if maxArticles > 0 && len(unique) > maxArticles {
		unique = unique[:maxArticles]
	}

	log.Printf("[NLP/Scraper] %d headline relevan untuk %s (dari %d feeds)",
		len(unique), clean, len(cryptoNewsFeeds))

	return unique
}

// fetchFeed mengambil dan mem-parse satu RSS feed URL.
// Menggantikan async fetch_feed(session, url) di news_scraper.py.
func fetchFeed(client *http.Client, url string) ([]rssItem, error) {
	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("HTTP GET: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20)) // max 2MB
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}

	var feed rssFeed
	if err := xml.Unmarshal(body, &feed); err != nil {
		// Beberapa feed pakai Atom, coba extract <title> tags secara manual
		return extractTitlesManual(body), nil
	}

	return feed.Channel.Items, nil
}

// extractTitlesManual adalah fallback parser untuk feed yang tidak valid XML.
// Ekstrak teks di antara <title> tags.
func extractTitlesManual(body []byte) []rssItem {
	var items []rssItem
	text := string(body)
	for {
		start := strings.Index(text, "<title>")
		if start == -1 {
			break
		}
		end := strings.Index(text[start:], "</title>")
		if end == -1 {
			break
		}
		title := text[start+7 : start+end]
		// Bersihkan CDATA dan HTML entities
		title = strings.TrimPrefix(title, "<![CDATA[")
		title = strings.TrimSuffix(title, "]]>")
		title = strings.TrimSpace(title)
		if title != "" {
			items = append(items, rssItem{Title: title})
		}
		text = text[start+end+8:]
	}
	return items
}

// containsAnyKeyword cek apakah text mengandung salah satu keyword (case-insensitive).
// Menggantikan: any(kw in title for kw in keywords) di news_scraper.py.
func containsAnyKeyword(text string, keywords []string) bool {
	lower := strings.ToLower(text)
	for _, kw := range keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	return false
}
