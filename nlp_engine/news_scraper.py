"""
[news_scraper.py]
=============
Scraper asinkron untuk menarik headline berita dari RSS feeds publik.

Agent: Linguist (Dependency)
Role: Data Ingestion (Text)
Dependencies: aiohttp, feedparser, asyncio
"""

import asyncio
import aiohttp
import feedparser
import logging
from typing import List

logger = logging.getLogger(__name__)

CRYPTO_NEWS_FEEDS = [
    "https://cointelegraph.com/rss",
    "https://coindesk.com/arc/outboundfeeds/rss/",
    "https://cryptopanic.com/news/rss/?auth_token=PUBLIC",
    "https://finance.yahoo.com/rss/2.0/headline?s=BTC-USD"
]

async def fetch_latest_news(symbol: str, max_articles: int = 20) -> List[str]:
    """
    Menarik headline berita dari multi-sumber secara concurrent.
    
    Args:
        symbol: Ticker (contoh: 'BTC', 'ETH')
        max_articles: Batas jumlah berita
    
    Returns:
        List string berisi headline berita yang relevan
    """
    # Bersihkan symbol (misal: BTCUSDT -> BTC)
    clean_symbol = symbol.replace("USDT", "").replace("USD", "").upper()
    keywords = [clean_symbol, clean_symbol.lower(), "crypto", "market"]
    
    headlines = []
    
    async def fetch_feed(session: aiohttp.ClientSession, url: str):
        try:
            async with session.get(url, timeout=5) as response:
                if response.status != 200:
                    return
                content = await response.text()
                feed = feedparser.parse(content)
                
                for entry in feed.entries:
                    title = entry.get('title', '')
                    # Filter: Hanya ambil headline yang mengandung keyword relevan
                    if any(kw in title for kw in keywords):
                        headlines.append(title)
        except Exception as e:
            logger.debug("[NewsScraper] Gagal fetch dari %s: %s", url, e)

    # Eksekusi semua request RSS secara paralel
    async with aiohttp.ClientSession() as session:
        tasks = [fetch_feed(session, url) for url in CRYPTO_NEWS_FEEDS]
        await asyncio.gather(*tasks, return_exceptions=True)

    # Hapus duplikat dan batasi jumlah
    unique_headlines = list(set(headlines))
    
    logger.info("[NewsScraper] Berhasil fetch %d headline relevan untuk %s", 
                min(len(unique_headlines), max_articles), clean_symbol)
                
    return unique_headlines[:max_articles]