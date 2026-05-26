// go-engine/nlp/scorer.go
//
// Port of Python nlp_engine/sentiment_scorer.py
// ===============================================
// Engine NLP lokal menggunakan VADER-lite yang diinjeksi dengan lexicon finansial.
// Menggantikan Python vaderSentiment + numpy.
//
// Arsitektur hybrid:
//   Final Score = (vaderLite * 0.40) + (lexiconScore * 0.60)
//   Range      : -1.0 (Extreme Bearish) .. +1.0 (Extreme Bullish)
//
// VADER-lite: Implementasi manual dari algoritma VADER inti — positive/negative
// word lookup + modifier (very/extremely/not) + exclamation boost.
// Cukup untuk crypto news scoring tanpa perlu full 7.5K-word VADER lexicon.

package nlp

import (
	"math"
	"sort"
	"strings"
)

// ── VADER-lite word lists ─────────────────────────────────────────────────────
//
// Subset dari VADER general-purpose lexicon (hanya kata relevan untuk
// financial/market context). Bobot mengikuti konvensi VADER (-4 .. +4),
// dinormalisasi ke -1..+1 saat perhitungan.

var vaderPositive = map[string]float64{
	// Keuangan/pasar
	"gain": 2.0, "gains": 2.0, "profit": 2.5, "profits": 2.5,
	"growth": 2.0, "growing": 1.8, "increase": 1.5, "increased": 1.5,
	"surge": 2.5, "surging": 2.5, "soar": 2.8, "soaring": 2.8,
	"rally": 2.5, "rallying": 2.5, "rise": 1.5, "rises": 1.5, "rising": 1.8,
	"climb": 1.5, "climbing": 1.5, "jump": 2.0, "jumping": 2.0,
	"outperform": 2.0, "outperforms": 2.0,
	"strong": 1.5, "strength": 1.5, "healthy": 1.5,
	"record": 2.0, "milestone": 1.5, "breakthrough": 2.5,
	"approval": 2.5, "approved": 2.5, "approve": 2.5,
	"partnership": 1.5, "collaboration": 1.5, "integration": 1.5,
	"launch": 1.5, "launches": 1.5, "launched": 1.5,
	"listing": 1.5, "listed": 1.5,
	"upgrade": 1.5, "upgraded": 1.5, "improvement": 1.5,
	"adoption": 2.0, "adoptions": 2.0,
	"invest": 1.5, "investing": 1.5, "investment": 1.5,
	"bull": 2.0, "bullish": 2.5, "bullrun": 3.0,
	"optimistic": 2.0, "optimism": 2.0, "confidence": 1.5,
	"positive": 1.5, "good": 1.0, "great": 2.0, "excellent": 2.5,
	"best": 2.0, "better": 1.5, "top": 1.5,
	"support": 1.5, "supported": 1.5,
	"recover": 1.5, "recovery": 1.5, "recovering": 1.5,
	"bounce": 1.5, "bounced": 1.5,
	"success": 2.0, "successful": 2.0, "succeed": 2.0,
	"win": 1.5, "winner": 1.5, "winning": 1.5,
	"benefit": 1.5, "benefits": 1.5,
	"opportunity": 1.5, "opportunities": 1.5,
	"secure": 1.0, "secured": 1.0, "security": 0.5,
	"safe": 1.0, "safely": 1.0,
	"high": 1.0, "higher": 1.2, "highest": 1.5,
	"up": 0.8, "upward": 1.2, "upside": 1.5,
	"bold": 1.0, "innovative": 1.5, "revolutionary": 2.0,
}

var vaderNegative = map[string]float64{
	// Keuangan/pasar
	"loss": -2.0, "losses": -2.0, "lose": -2.0, "losing": -2.0,
	"decline": -1.5, "declining": -1.5, "decreased": -1.5, "decrease": -1.5,
	"drop": -1.5, "dropping": -1.5, "dropped": -1.5,
	"fall": -1.5, "falls": -1.5, "falling": -1.5, "fell": -1.5,
	"plunge": -2.5, "plunging": -2.5, "plummeted": -3.0, "plummet": -3.0,
	"crash": -3.5, "crashes": -3.5, "crashed": -3.5, "crashing": -3.5,
	"collapse": -3.0, "collapsing": -3.0, "collapsed": -3.0,
	"tumble": -2.0, "tumbles": -2.0, "tumbling": -2.0,
	"dump": -2.5, "dumps": -2.5, "dumping": -2.5,
	"selloff": -2.5, "sell-off": -2.5,
	"fear": -2.0, "fears": -2.0, "fearful": -2.0,
	"panic": -3.0, "panicking": -3.0, "panicked": -3.0,
	"worry": -1.5, "worried": -1.5, "worries": -1.5, "concern": -1.5,
	"uncertainty": -1.5, "uncertain": -1.5,
	"risk": -1.0, "risky": -1.5, "risks": -1.0,
	"danger": -2.0, "dangerous": -2.0, "threat": -1.5,
	"warning": -1.5, "warn": -1.5, "warns": -1.5,
	"fraud": -3.5, "scam": -3.5, "ponzi": -3.5,
	"hack": -3.0, "hacked": -3.0, "exploit": -2.5, "exploited": -2.5,
	"breach": -2.5, "breached": -2.5,
	"ban": -2.5, "banned": -2.5, "bans": -2.5,
	"lawsuit": -2.0, "sued": -2.0, "investigation": -1.5,
	"regulate": -1.5, "regulation": -1.5, "enforcement": -1.5,
	"bankrupt": -3.5, "bankruptcy": -3.5, "insolvent": -3.0,
	"default": -2.5, "defaults": -2.5,
	"delist": -2.5, "delisting": -2.5, "delisted": -2.5,
	"suspend": -2.0, "suspended": -2.0, "halt": -1.5, "halted": -1.5,
	"freeze": -2.0, "frozen": -2.0,
	"bear": -2.0, "bearish": -2.5, "bearrun": -2.8,
	"problem": -1.5, "problems": -1.5, "issue": -1.0, "issues": -1.0,
	"fail": -2.0, "failed": -2.0, "failure": -2.0, "failing": -2.0,
	"bad": -1.5, "poor": -1.5, "worst": -2.5, "worse": -1.5,
	"negative": -1.5, "low": -0.8, "lower": -1.0, "lowest": -1.5,
	"down": -0.8, "downward": -1.2, "downside": -1.5,
	"weak": -1.5, "weakness": -1.5,
	"wrong": -1.5, "error": -1.0,
	"attack": -2.5, "attacked": -2.5,
	"drain": -2.0, "drained": -2.0,
	"contagion": -2.5,
	"depeg": -2.8, "depegged": -2.8,
	"rug": -3.0, "rugpull": -3.5,
}

// intensifiers memodifikasi skor kata berikutnya (naikan absolut ~30%)
var intensifiers = map[string]float64{
	"very": 1.3, "extremely": 1.5, "massively": 1.5,
	"hugely": 1.4, "significantly": 1.3, "heavily": 1.3,
	"deeply": 1.3, "strongly": 1.3, "sharply": 1.4,
	"dramatically": 1.5, "absolutely": 1.4, "completely": 1.4,
	"severely": 1.4, "highly": 1.2, "incredibly": 1.4,
	"seriously": 1.3, "particularly": 1.1, "substantially": 1.3,
	"unprecedented": 1.5,
}

// negators membalik polaritas kata berikutnya
var negators = map[string]bool{
	"not": true, "no": true, "never": true, "nobody": true,
	"nothing": true, "neither": true, "nor": true,
	"cannot": true, "can't": true, "won't": true, "doesn't": true,
	"didn't": true, "isn't": true, "aren't": true, "wasn't": true,
	"weren't": true, "don't": true, "haven't": true,
	"hasn't": true, "without": true,
}

// ── SentimentStats ────────────────────────────────────────────────────────────

// SentimentStats adalah hasil agregasi corpus scoring.
// Identik dengan dataclass SentimentStats di sentiment_scorer.py.
type SentimentStats struct {
	MeanScore   float64
	StdScore    float64
	NBullish    int
	NBearish    int
	NNeutral    int
	FearGreed   string
	TopKeywords []string
}

// ── HybridScorer ─────────────────────────────────────────────────────────────

// HybridScorer adalah port dari class HybridSentimentScorer di sentiment_scorer.py.
// Menggabungkan VADER-lite (40%) + domain lexicon (60%).
type HybridScorer struct {
	// field kosong — semua lookup via package-level maps
}

// NewHybridScorer membuat instance baru HybridScorer.
// Port dari __init__ di HybridSentimentScorer.
func NewHybridScorer() *HybridScorer {
	return &HybridScorer{}
}

// ScoreText menghitung skor sentimen satu teks.
// Range: -1.0 (Extreme Bearish) .. +1.0 (Extreme Bullish).
// Port langsung dari score_text() di sentiment_scorer.py.
//
// Formula: final = clip((vaderLite * 0.4) + (lexiconScore * 0.6), -1, 1)
func (h *HybridScorer) ScoreText(text string) float64 {
	vaderScore := h.vaderLiteCompound(text)
	lexScore := h.lexiconScore(text)
	final := vaderScore*0.40 + lexScore*0.60
	return clip(final, -1.0, 1.0)
}

// ScoreCorpus menilai slice of texts dan mengembalikan statistik agregat.
// Port langsung dari score_corpus() di sentiment_scorer.py.
//
// Melakukan outlier filtering (> 2 standard deviasi) sebelum averaging.
func (h *HybridScorer) ScoreCorpus(texts []string) (SentimentStats, []float64) {
	if len(texts) == 0 {
		return h.emptyStats(), nil
	}

	// Skor setiap teks
	rawScores := make([]float64, len(texts))
	for i, t := range texts {
		rawScores[i] = h.ScoreText(t)
	}

	// Hitung mean & std dari raw scores
	mean := meanFloat(rawScores)
	std := stdFloat(rawScores)

	// Buang outlier (> 2 sigma) — identik dengan Python
	var valid []float64
	for _, s := range rawScores {
		if math.Abs(s-mean) <= 2*std {
			valid = append(valid, s)
		}
	}
	if len(valid) == 0 {
		valid = rawScores // fallback jika semua outlier
	}

	finalMean := meanFloat(valid)
	finalStd := stdFloat(valid)

	// Hitung distribusi arah
	nBull, nBear, nNeut := 0, 0, 0
	for _, s := range valid {
		switch {
		case s > 0.1:
			nBull++
		case s < -0.1:
			nBear++
		default:
			nNeut++
		}
	}

	// Fear & Greed mapping — identik dengan Python
	fg := mapFearGreed(finalMean)

	// Top keywords dari seluruh corpus
	topKws := h.extractTopKeywords(texts, 5)

	stats := SentimentStats{
		MeanScore:   roundTo(finalMean, 4),
		StdScore:    roundTo(finalStd, 4),
		NBullish:    nBull,
		NBearish:    nBear,
		NNeutral:    nNeut,
		FearGreed:   fg,
		TopKeywords: topKws,
	}
	return stats, valid
}

// ── Internal methods ──────────────────────────────────────────────────────────

// vaderLiteCompound mengimplementasikan inti algoritma VADER tanpa external dep.
// Menghasilkan compound score dalam range -1..+1.
//
// Algoritma:
//  1. Tokenize lowercase
//  2. Lookup setiap token di vaderPositive / vaderNegative
//  3. Terapkan intensifier dari token sebelumnya
//  4. Terapkan negasi dari token 1-2 posisi sebelumnya
//  5. Boost kecil untuk exclamation & caps
//  6. Normalisasi dengan rumus VADER: x / sqrt(x^2 + alpha)
func (h *HybridScorer) vaderLiteCompound(text string) float64 {
	words := tokenize(text)
	if len(words) == 0 {
		return 0
	}

	var sentiments []float64
	for i, word := range words {
		var score float64

		if s, ok := vaderPositive[word]; ok {
			score = s
		} else if s, ok := vaderNegative[word]; ok {
			score = s
		} else {
			continue
		}

		// Terapkan intensifier dari token sebelumnya
		if i > 0 {
			if mult, ok := intensifiers[words[i-1]]; ok {
				score *= mult
			}
		}

		// Terapkan negasi (token -1 atau -2)
		negated := false
		if i > 0 && negators[words[i-1]] {
			negated = true
		} else if i > 1 && negators[words[i-2]] {
			negated = true
		}
		if negated {
			score = -score * 0.74 // VADER damping factor
		}

		sentiments = append(sentiments, score)
	}

	if len(sentiments) == 0 {
		return 0
	}

	// Exclamation boost (setiap '!' tambah 0.292, max 3 tanda)
	excl := min(strings.Count(text, "!"), 3)
	sum := 0.0
	for _, s := range sentiments {
		sum += s
	}
	if sum > 0 {
		sum += float64(excl) * 0.292
	} else if sum < 0 {
		sum -= float64(excl) * 0.292
	}

	// VADER normalization formula: x / sqrt(x^2 + 15)
	const alpha = 15.0
	compound := sum / math.Sqrt(sum*sum+alpha)
	return clip(compound, -1.0, 1.0)
}

// lexiconScore menghitung skor murni dari crypto/financial lexicon.
// Port dari komponen lexicon di score_text() di Python.
func (h *HybridScorer) lexiconScore(text string) float64 {
	lower := strings.ToLower(text)
	words := strings.Fields(lower)

	var total float64
	matches := 0

	// Skor single words
	for _, word := range words {
		if s, ok := BullishTerms[word]; ok {
			total += s
			matches++
		} else if s, ok := BearishTerms[word]; ok {
			total += s
			matches++
		}
	}

	// Skor bigrams (e.g. "rug pull", "all-time high", "etf approval")
	for i := 0; i < len(words)-1; i++ {
		bigram := words[i] + " " + words[i+1]
		if s, ok := BullishTerms[bigram]; ok {
			total += s
			matches++
		} else if s, ok := BearishTerms[bigram]; ok {
			total += s
			matches++
		}
	}

	if matches == 0 {
		return 0
	}
	return clip(total/float64(matches), -1.0, 1.0)
}

// extractTopKeywords mengembalikan top-N financial keywords paling sering muncul.
// Port dari komponen Counter(financial_words).most_common(5) di Python.
func (h *HybridScorer) extractTopKeywords(texts []string, n int) []string {
	freq := make(map[string]int)
	for _, text := range texts {
		for _, word := range strings.Fields(strings.ToLower(text)) {
			if _, ok := FinancialVocab[word]; ok {
				freq[word]++
			}
		}
	}

	type kv struct {
		key string
		val int
	}
	var sorted []kv
	for k, v := range freq {
		sorted = append(sorted, kv{k, v})
	}
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].val > sorted[j].val
	})

	result := make([]string, 0, n)
	for i, item := range sorted {
		if i >= n {
			break
		}
		result = append(result, item.key)
	}
	return result
}

// emptyStats returns zero stats when corpus is empty.
func (h *HybridScorer) emptyStats() SentimentStats {
	return SentimentStats{FearGreed: "NEUTRAL"}
}

// ── Utility functions ─────────────────────────────────────────────────────────

// tokenize memecah teks menjadi lowercase tokens, membuang punctuation.
func tokenize(text string) []string {
	lower := strings.ToLower(text)
	// Ganti tanda baca dengan spasi
	var b strings.Builder
	for _, r := range lower {
		if r >= 'a' && r <= 'z' || r == '\'' || r == '-' || r == ' ' {
			b.WriteRune(r)
		} else {
			b.WriteRune(' ')
		}
	}
	raw := strings.Fields(b.String())
	// Buang token terlalu pendek
	var out []string
	for _, w := range raw {
		if len(w) >= 2 {
			out = append(out, w)
		}
	}
	return out
}

// mapFearGreed mapping mean score ke label Fear & Greed.
// Identik dengan mapping if/elif di score_corpus() Python.
func mapFearGreed(mean float64) string {
	switch {
	case mean > 0.5:
		return "EXTREME_GREED"
	case mean > 0.1:
		return "GREED"
	case mean < -0.5:
		return "EXTREME_FEAR"
	case mean < -0.1:
		return "FEAR"
	default:
		return "NEUTRAL"
	}
}

func meanFloat(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := 0.0
	for _, x := range xs {
		s += x
	}
	return s / float64(len(xs))
}

func stdFloat(xs []float64) float64 {
	if len(xs) < 2 {
		return 0
	}
	m := meanFloat(xs)
	v := 0.0
	for _, x := range xs {
		d := x - m
		v += d * d
	}
	return math.Sqrt(v / float64(len(xs)))
}

func clip(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

func roundTo(x float64, decimals int) float64 {
	pow := math.Pow(10, float64(decimals))
	return math.Round(x*pow) / pow
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
