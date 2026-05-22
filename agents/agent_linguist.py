"""
[agent_linguist.py]
=============
Agen spesialis NLP yang membaca berita secara asinkron di background,
menghitung skor sentimen, dan menyediakan hasil via cache memori
untuk menghindari block event-loop saat trading.

Agent: Linguist
Role: Social Sentiment & News Analysis
Dependencies: nlp_engine, asyncio, datetime
"""

import logging
import asyncio
from datetime import datetime, timezone
from dataclasses import dataclass

from nlp_engine.news_scraper import fetch_latest_news
from nlp_engine.sentiment_scorer import HybridSentimentScorer, SentimentStats

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class SentimentSignal:
    sentiment_score: float
    sentiment_label: str
    fear_greed_index: str
    news_count: int
    confidence: float
    top_keywords: list
    data_freshness: str
    reasoning: str

class LinguistAgent:
    def __init__(self, news_interval_seconds: int = 300, max_articles: int = 20):
        self.interval = news_interval_seconds
        self.max_articles = max_articles
        self.scorer = HybridSentimentScorer()
        self._cached_signal = self._empty_signal()

    async def start_background_feed(self, symbol: str, stop_event: asyncio.Event):
        """Loop asinkron yang jalan independen dari main trading loop."""
        logger.info("[Linguist] Background feed dimulai untuk %s. Update tiap %ds", symbol, self.interval)
        
        while not stop_event.is_set():
            try:
                # 1. Fetch
                headlines = await fetch_latest_news(symbol, self.max_articles)
                
                # 2. Score
                stats, scores = self.scorer.score_corpus(headlines)
                
                # 3. Convert ke Signal
                label = "NEUTRAL"
                if stats.mean_score > 0.4: label = "VERY_BULLISH"
                elif stats.mean_score > 0.1: label = "BULLISH"
                elif stats.mean_score < -0.4: label = "VERY_BEARISH"
                elif stats.mean_score < -0.1: label = "BEARISH"

                # Confidence bertambah seiring jumlah berita
                confidence = min(len(headlines) / 10.0, 1.0)
                # Kurangi confidence jika standar deviasi tinggi (berita kontradiktif)
                if stats.std_score > 0.5:
                    confidence *= 0.7

                timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                
                reasoning = (
                    f"Label: {label}. Bull/Bear/Neut: {stats.n_bullish}/{stats.n_bearish}/{stats.n_neutral}. "
                    f"Keywords: {', '.join(stats.top_keywords)}."
                )

                new_signal = SentimentSignal(
                    sentiment_score=stats.mean_score,
                    sentiment_label=label,
                    fear_greed_index=stats.fear_greed,
                    news_count=len(headlines),
                    confidence=round(confidence, 4),
                    top_keywords=stats.top_keywords,
                    data_freshness=timestamp,
                    reasoning=reasoning
                )
                
                # Atomic update ke cache
                self._cached_signal = new_signal
                logger.debug("[Linguist] Signal diupdate: %s (Score: %.2f)", label, stats.mean_score)

            except Exception as e:
                logger.exception("[Linguist] Error di background feed: %s", e)
            
            # Tidur selama interval atau sampai stop_event menyala
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=self.interval)
            except asyncio.TimeoutError:
                pass # Lanjut loop jika timeout tercapai (waktu fetch berikutnya tiba)

    async def analyze(self, symbol: str) -> SentimentSignal:
        """
        Mengembalikan sinyal yang sudah di-cache.
        Sangat cepat, kompleksitas O(1), tidak memblokir loop eksekutor.
        """
        # Note: parameter 'symbol' hanya untuk mempertahankan signature interface seragam antar agent.
        # Data sudah spesifik symbol dari start_background_feed.
        return self._cached_signal

    def _empty_signal(self) -> SentimentSignal:
        return SentimentSignal(
            0.0, "NEUTRAL", "NEUTRAL", 0, 0.0, [], 
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), 
            "Waiting for background data..."
        )