// go-engine/nlp/lexicon.go
//
// Port of Python nlp_engine/lexicon.py
// =====================================
// Domain-specific financial/crypto vocabulary dengan bobot sentimen.
// Diinjeksi ke dalam HybridScorer sebagai lapisan knowledge tambahan
// di atas base VADER-lite scorer.
//
// Bobot:  +1.0 (extreme bullish)  ..  0.0 (neutral)  ..  -1.0 (extreme bearish)
// Bahasa: Inggris + Indonesia (bilingual crypto community)

package nlp

// BullishTerms adalah kamus kata bullish beserta bobotnya.
// Identik dengan BULLISH_TERMS di lexicon.py.
var BullishTerms = map[string]float64{
	// ── Inggris ───────────────────────────────────────────────────────────
	"bullish":        1.0,
	"pump":           0.8,
	"moon":           0.9,
	"ath":            1.0,
	"all-time high":  1.0,
	"all time high":  1.0,
	"rally":          0.8,
	"breakout":       0.7,
	"surge":          0.8,
	"soar":           0.9,
	"spike":          0.6,
	"accumulation":   0.9,
	"buy":            0.5,
	"long":           0.5,
	"profit":         0.7,
	"bull":           0.8,
	"uptrend":        0.8,
	"support":        0.5,
	"recovery":       0.7,
	"adoption":       0.6,
	"institutional":  0.7,
	"etf approval":   1.0,
	"etf":            0.6,
	"fed pivot":      0.8,
	"rate cut":       0.7,
	"halving":        0.8,
	"inflow":         0.6,
	"bottom":         0.5,
	"bounce":         0.6,
	"oversold":       0.5,
	"golden cross":   0.8,
	"breakeven":      0.4,
	"upgrade":        0.5,
	"partnership":    0.5,
	"listing":        0.6,
	"launch":         0.5,
	"airdrop":        0.5,
	"staking":        0.4,
	"yield":          0.4,
	"hodl":           0.5,
	"accumulate":     0.7,
	"outperform":     0.6,
	"milestone":      0.5,
	"record":         0.6,
	"high":           0.3,
	"gain":           0.5,
	"rise":           0.5,
	"growth":         0.5,
	"strong":         0.4,
	"bullrun":        0.9,
	"bull run":       0.9,
	"reversal":       0.5, // context-dependent, treated bullish here

	// ── Indonesia ────────────────────────────────────────────────────────
	"naik":    0.6,
	"terbang": 0.9,
	"meledak": 0.8,
	"hijau":   0.5,
	"cuan":    0.8,
	"peluang": 0.4,
	"rebound": 0.6,
	"booming": 0.7,
}

// BearishTerms adalah kamus kata bearish beserta bobotnya (negatif).
// Identik dengan BEARISH_TERMS di lexicon.py.
var BearishTerms = map[string]float64{
	// ── Inggris ───────────────────────────────────────────────────────────
	"crash":        -1.0,
	"dump":         -0.9,
	"bear":         -0.7,
	"bearish":      -0.8,
	"sell":         -0.5,
	"short":        -0.5,
	"bankrupt":     -1.0,
	"bankruptcy":   -1.0,
	"hack":         -0.9,
	"hacked":       -0.9,
	"exploit":      -0.8,
	"fraud":        -1.0,
	"scam":         -1.0,
	"ponzi":        -1.0,
	"regulation":   -0.6,
	"ban":          -0.9,
	"banned":       -0.9,
	"lawsuit":      -0.8,
	"sec":          -0.5,
	"panic":        -0.9,
	"fear":         -0.7,
	"collapse":     -1.0,
	"liquidation":  -0.7,
	"margin call":  -0.8,
	"rug pull":     -1.0,
	"rug":          -0.9,
	"exit scam":    -1.0,
	"exit-scam":    -1.0,
	"delisting":    -0.8,
	"delist":       -0.8,
	"downtrend":    -0.7,
	"resistance":   -0.4,
	"overbought":   -0.5,
	"dead cross":   -0.8,
	"outflow":      -0.5,
	"selloff":      -0.8,
	"sell-off":     -0.8,
	"capitulation": -0.7,
	"correction":   -0.5,
	"pullback":     -0.4,
	"flash crash":  -0.9,
	"flash-crash":  -0.9,
	"insolvent":    -0.9,
	"contagion":    -0.8,
	"depegged":     -0.9,
	"depeg":        -0.9,
	"warning":      -0.4,
	"risk":         -0.3,
	"vulnerable":   -0.4,
	"breach":       -0.7,
	"attack":       -0.7,
	"suspended":    -0.7,
	"halt":         -0.5,
	"freeze":       -0.6,
	"frozen":       -0.6,
	"drain":        -0.6,
	"drained":      -0.7,
	"loss":         -0.5,
	"losses":       -0.5,
	"down":         -0.3,
	"drop":         -0.5,
	"fall":         -0.4,
	"fell":         -0.4,
	"decline":      -0.4,
	"weak":         -0.4,
	"concern":      -0.3,
	"concerns":     -0.3,
	"uncertainty":  -0.4,
	"bearrun":      -0.8,
	"bear run":     -0.8,

	// ── Indonesia ────────────────────────────────────────────────────────
	"turun":   -0.6,
	"jeblok":  -0.9,
	"amblas":  -0.9,
	"hancur":  -0.8,
	"merah":   -0.5,
	"rugi":    -0.6,
	"anjlok":  -0.8,
	"jatuh":   -0.6,
	"bangkrut": -1.0,
}

// FinancialVocab adalah union set dari semua kata dalam lexicon (untuk keyword extraction).
var FinancialVocab map[string]struct{}

func init() {
	FinancialVocab = make(map[string]struct{}, len(BullishTerms)+len(BearishTerms))
	for k := range BullishTerms {
		FinancialVocab[k] = struct{}{}
	}
	for k := range BearishTerms {
		FinancialVocab[k] = struct{}{}
	}
}
