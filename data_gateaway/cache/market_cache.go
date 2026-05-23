package cache

import (
	"sync"
	"time"
)

// CacheItem menyimpan data beserta batas waktu kedaluwarsanya
type CacheItem struct {
	Data      interface{}
	ExpiresAt time.Time
}

// MarketCache adalah memori thread-safe untuk meredam pemanggilan CEX berlebih
type MarketCache struct {
	mu    sync.RWMutex
	items map[string]CacheItem
}

// GlobalCache adalah instansiasi tunggal untuk digunakan di seluruh lapisan handler
var GlobalCache = &MarketCache{
	items: make(map[string]CacheItem),
}

// Set menyimpan nilai ke dalam cache dengan batas waktu TTL (Time-To-Live)
func (c *MarketCache) Set(key string, value interface{}, ttl time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.items[key] = CacheItem{
		Data:      value,
		ExpiresAt: time.Now().Add(ttl),
	}
}

// Get mengambil nilai dari cache. Mengembalikan false jika tidak ditemukan atau kadaluarsa.
func (c *MarketCache) Get(key string) (interface{}, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	item, found := c.items[key]
	if !found {
		return nil, false
	}

	// Lazy eviction check
	if time.Now().After(item.ExpiresAt) {
		return nil, false
	}

	return item.Data, true
}