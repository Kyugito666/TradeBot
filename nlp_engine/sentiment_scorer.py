"""
[sentiment_scorer.py]
=============
Engine NLP lokal menggunakan VADER yang diinjeksi dengan lexicon finansial.
Termasuk filter anomali statistik untuk membuang berita noise.

Agent: Linguist (Dependency)
Role: Text Sentiment Analysis
Dependencies: vaderSentiment, numpy
"""

import logging
import numpy as np
from dataclasses import dataclass
from collections import Counter
from typing import List, Tuple
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

from nlp_engine.lexicon import BULLISH_TERMS, BEARISH_TERMS

logger = logging.getLogger(__name__)

@dataclass(frozen=True, slots=True)
class SentimentStats:
    mean_score: float
    std_score: float
    n_bullish: int
    n_bearish: int
    n_neutral: int
    fear_greed: str
    top_keywords: list

class HybridSentimentScorer:
    def __init__(self):
        self.vader = SentimentIntensityAnalyzer()
        # Injeksi domain-specific knowledge ke VADER
        self.vader.lexicon.update(BULLISH_TERMS)
        self.vader.lexicon.update(BEARISH_TERMS)
        self.financial_vocab = set(BULLISH_TERMS.keys()).union(set(BEARISH_TERMS.keys()))

    def score_text(self, text: str) -> float:
        """
        Menghitung skor sentimen -1.0 (Extreme Bearish) sampai +1.0 (Extreme Bullish).
        Menggunakan kombinasi VADER Compound (40%) dan Lexicon murni (60%).
        """
        vader_score = self.vader.polarity_scores(text)['compound']
        
        words = text.lower().split()
        lex_score = 0.0
        matches = 0
        
        for word in words:
            if word in BULLISH_TERMS:
                lex_score += BULLISH_TERMS[word]
                matches += 1
            elif word in BEARISH_TERMS:
                lex_score += BEARISH_TERMS[word]
                matches += 1
                
        avg_lex_score = (lex_score / matches) if matches > 0 else 0.0
        
        # Hybrid weighting
        final_score = (vader_score * 0.4) + (avg_lex_score * 0.6)
        return float(np.clip(final_score, -1.0, 1.0))

    def score_corpus(self, texts: List[str]) -> Tuple[SentimentStats, List[float]]:
        if not texts:
            return self._empty_stats(), []

        raw_scores = [self.score_text(t) for t in texts]
        
        # Buang outlier (> 2 standard deviasi)
        mean_raw = np.mean(raw_scores)
        std_raw = np.std(raw_scores)
        valid_scores = [s for s in raw_scores if abs(s - mean_raw) <= (2 * std_raw)]
        
        if not valid_scores:
            valid_scores = raw_scores

        final_mean = float(np.mean(valid_scores))
        final_std = float(np.std(valid_scores))
        
        n_bull = sum(1 for s in valid_scores if s > 0.1)
        n_bear = sum(1 for s in valid_scores if s < -0.1)
        n_neut = len(valid_scores) - (n_bull + n_bear)
        
        # Fear & Greed Mapping
        if final_mean > 0.5: fg = "EXTREME_GREED"
        elif final_mean > 0.1: fg = "GREED"
        elif final_mean < -0.5: fg = "EXTREME_FEAR"
        elif final_mean < -0.1: fg = "FEAR"
        else: fg = "NEUTRAL"

        # Ekstraksi Top Keywords
        all_words = " ".join(texts).lower().split()
        financial_words = [w for w in all_words if w in self.financial_vocab]
        top_kws = [word for word, count in Counter(financial_words).most_common(5)]

        stats = SentimentStats(
            mean_score=round(final_mean, 4),
            std_score=round(final_std, 4),
            n_bullish=n_bull,
            n_bearish=n_bear,
            n_neutral=n_neut,
            fear_greed=fg,
            top_keywords=top_kws
        )
        return stats, valid_scores

    def _empty_stats(self) -> SentimentStats:
        return SentimentStats(0.0, 0.0, 0, 0, 0, "NEUTRAL", [])