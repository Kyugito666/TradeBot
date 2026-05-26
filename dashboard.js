// dashboard.js — TradeBot v3.0.2
// FIXES:
// [FIX-1] OI: improved timestamp detection (ms + seconds range)
// [FIX-2] Percentage: WS ticker is sole source, bot_insight pct_24h NEVER overrides
// [FIX-3] AI INSIGHT → AI SIGNAL: independent multi-pair scanner, jalan tanpa bot
// [FIX-4] Markers: retry mechanism + guard kalau chart belum ready
// [FIX-5] Trade history: fix guard condition yang block render

let logs = [];
let filterLevel = 'ALL';
let autoScroll = true;
let lastCount = 0;
let _lwChart = null;
let _candleSeries = null;
let _volSeries = null;
let _currentTf = '5';
let _ohlcvCache = {};
let _chartReady = false;
let _lastCandleTs = 0;
let priceHistory = [];
const MAX_CHART_POINTS = 150;

let stats = {
  price: null, prevPrice: null, atr: null, oi: null, oiTime: null,
  lsr: null, bias: 'NEUTRAL', balance: null, initBalance: null, risk_pct: 0.03
};

let activeTrade = null;
let tradeHistory = [];
let signalCount = 0;
let totalPnl = 0;
let isChartHidden = false;

// Safe Storage Wrapper
const Storage = {
    get(key, defaultVal = null) {
        try { 
            const v = localStorage.getItem(key); 
            return v ? JSON.parse(v) : defaultVal; 
        } catch(e) { return defaultVal; }
    },
    set(key, val) {
        try { 
            localStorage.setItem(key, JSON.stringify(val)); 
            return true; 
        } catch(e) { 
            console.warn('Storage unavailable:', e); 
            return false; 
        }
    },
    remove(key) {
        try { localStorage.removeItem(key); } catch(e) {}
    }
};

function toggleChart() {
  isChartHidden = !isChartHidden;
  document.getElementById('chart-wrapper').style.display = isChartHidden ? 'none' : 'flex';
  document.getElementById('chart-toolbar').style.display = isChartHidden ? 'none' : 'flex';
  document.getElementById('chart-legend').style.display = isChartHidden ? 'none' : 'flex';
  document.getElementById('btn-toggle-chart').textContent = isChartHidden ? '👁️ Show Chart' : '👁️ Hide Chart';
}

function syncLev(source) {
  const num = document.getElementById('cfg-leverage');
  const slide = document.getElementById('cfg-lev-slider');
  const disp = document.getElementById('lev-val-display');
  if (source === 'slider') num.value = slide.value;
  else slide.value = num.value;
  disp.textContent = slide.value + 'x';
  limitLeverageInput(num);
}

function updateLeverageLimits() {
  const exchange = document.getElementById('cfg-exchange').value;
  const symbol = document.getElementById('cfg-symbol').value || 'BTCUSDT';
  const num = document.getElementById('cfg-leverage');
  const slide = document.getElementById('cfg-lev-slider');
  let maxLev = 50; 
  if (exchange === 'mexc') {
    if (symbol.includes('BTC') || symbol.includes('ETH')) maxLev = 200;
    else maxLev = 100;
  } else if (exchange === 'bybit') {
    if (symbol.includes('BTC') || symbol.includes('ETH')) maxLev = 100;
    else maxLev = 50;
  }
  num.max = maxLev; slide.max = maxLev;
  if (parseInt(num.value) > maxLev) {
    num.value = maxLev; slide.value = maxLev;
    document.getElementById('lev-val-display').textContent = maxLev + 'x';
    saveToLocal();
  }
}

function limitLeverageInput(el) {
  const max = parseInt(el.max) || 100;
  if (parseInt(el.value) > max) { 
      el.value = max; document.getElementById('cfg-lev-slider').value = max; 
      document.getElementById('lev-val-display').textContent = max + 'x'; 
  }
  saveToLocal();
}

function saveSimState() { 
    Storage.set('botSimHist', { tradeHistory, totalPnl, signalCount, activeTrade }); 
}

function loadSimState() {
  try {
    const d = Storage.get('botSimHist');
    if(d) {
      tradeHistory = d.tradeHistory || []; totalPnl = d.totalPnl || 0; 
      signalCount = d.signalCount || 0; activeTrade = d.activeTrade || null;
      updateTradeStats(); renderTradesTable();
    }
    const savedBal = Storage.get('botInitBalance');
    if(savedBal) stats.initBalance = parseFloat(savedBal);
  } catch(e) {}
}

function resetHistory() {
  if (confirm("Reset semua histori P&L dan Win Rate di browser?")) {
    tradeHistory = []; totalPnl = 0; signalCount = 0; activeTrade = null; stats.initBalance = null;
    Storage.remove('botInitBalance');
    saveSimState(); updateTradeStats(); updateBalanceStats(); renderTradesTable();
  }
}

// ── PARSERS ──────────────────────────────────────────────────────────────────
const PARSERS = [
  { re: /\[main\]   Exchange connected \| exchange=\w+ mode=\w+ \| free_USDT=([\d.]+)/, fn(m) { 
      const b = parseFloat(m[1]); stats.balance = b; 
      if (!stats.initBalance) { stats.initBalance = b; Storage.set('botInitBalance', b); } 
      updateBalanceStats(); 
  } },
  { re: /Harga Real-Time \w+: ([\d.]+)/, fn(m) { 
      const price = parseFloat(m[1]); stats.prevPrice = stats.price; stats.price = price; 
      addPricePoint(price, null, null, null); 
      if (activeTrade) checkTradeOutcome(price); updatePriceStats(); 
  } },
  { re: /\[OI\]\s+\S+\s+oi=([\d.]+)/, fn(m) { 
      const raw = parseFloat(m[1]);
      // [FIX-1] Jangan set OI kalau nilainya kelihatan seperti Unix timestamp
      if (!isLikelyTimestamp(raw)) { stats.oi = raw; stats.oiTime = new Date().toLocaleTimeString(); updateOIStats(); }
  } },
  { re: /\[WHALE\]\s+\S+\s+LSR=([\d.]+)\s+bias=(\w+)/, fn(m) { stats.lsr = parseFloat(m[1]); stats.bias = m[2]; updateLSRStats(); } },
  { re: /\[Executor\] entry=([\d.]+)\s+SL=([\d.]+)\s+TP=([\d.]+)\s+RR=([\d.]+)\s+conf=([\d.]+)/, fn(m) { 
      pendingTradeParams = { entry: parseFloat(m[1]), sl: parseFloat(m[2]), tp: parseFloat(m[3]), rr: parseFloat(m[4]), conf: parseFloat(m[5]) }; 
  } },
  { re: /\[Executor\]   (BUY|SELL)\s/, fn(m) { pendingAction = m[1]; } },
  { re: /\[StateDB\] Saved trade row_id/, fn() { 
      if (pendingTradeParams && pendingAction) { openDryTrade(pendingAction, pendingTradeParams); pendingTradeParams = null; pendingAction = null; } 
  } },
  { re: /\[Paper\]\s+.* Virtual Order opened:\s+(BUY|SELL)/, fn(m) {
      const action = m[1];
      if (pendingTradeParams) {
          openDryTrade(action, pendingTradeParams);
          pendingTradeParams = null; pendingAction = null;
      } else if (stats.price) {
          addSignalMarker(action, stats.price);
          signalCount++; saveSimState(); updateTradeStats();
      }
  } },
  { re: /\[ConsensusEngine\] Hasil: (BUY|SELL)/, fn(m) { 
      const action = m[1]; signalCount++; saveSimState(); updateTradeStats(); 
      if (stats.price) addSignalMarker(action, stats.price); 
  } },
  { re: /\[main\] Signal: (BUY|SELL) conf=([\d.]+) entry=([\d.]+) TP=([\d.]+) SL=([\d.]+) RR=([\d.]+)/, fn(m) {
      pendingAction = m[1];
      pendingTradeParams = { entry: parseFloat(m[3]), sl: parseFloat(m[5]), tp: parseFloat(m[4]), rr: parseFloat(m[6]), conf: parseFloat(m[2]) };
  } }
];

let pendingTradeParams = null;
let pendingAction = null;

function parseLog(log) { 
    for (const p of PARSERS) { const m = log.msg.match(p.re); if (m) { p.fn(m, log); break; } } 
}

// ── [FIX-1] Helper: deteksi apakah nilai itu Unix timestamp ──────────────────
// Unix ms timestamp untuk tahun 2020-2035: 1.58e12 – 2.05e12
// Unix sec timestamp untuk tahun 2020-2035: 1.58e9 – 2.05e9
function isLikelyTimestamp(v) {
    if (!v || isNaN(v)) return false;
    // Range Unix ms (milli): tahun 2020-2035
    if (v >= 1.58e12 && v <= 2.05e12) return true;
    // Range Unix sec: tahun 2020-2035
    if (v >= 1.58e9 && v <= 2.05e9) return true;
    // Value gila, pasti bukan OI real
    if (v > 1e11) return true;
    return false;
}

function openDryTrade(action, params) { 
    if (activeTrade) closeTrade(null, null); 
    activeTrade = { action, ...params, time: new Date().toLocaleTimeString() }; 
    addSignalMarker(action, params.entry); setTpSlLines(params.entry, params.tp, params.sl); 
    saveSimState(); updateTradeStats(); renderTradesTable(); 
}

function checkTradeOutcome(currentPrice) { 
    if (!activeTrade) return; 
    const { action, entry, tp, sl } = activeTrade; 
    let result = null; let exitPrice = null; 
    if (action === 'BUY') { 
        if (currentPrice >= tp) { result = 'WIN'; exitPrice = tp; } 
        else if (currentPrice <= sl) { result = 'LOSS'; exitPrice = sl; } 
    } else { 
        if (currentPrice <= tp) { result = 'WIN'; exitPrice = tp; } 
        else if (currentPrice >= sl) { result = 'LOSS'; exitPrice = sl; } 
    } 
    if (result) closeTrade(result, exitPrice); 
}

function closeTrade(result, exitPrice) { 
    if (!activeTrade) return; 
    let pnl_pct = 0; 
    if (result === 'WIN') pnl_pct = stats.risk_pct * activeTrade.rr * 100; 
    if (result === 'LOSS') pnl_pct = -stats.risk_pct * 100; 
    if (result) { 
        tradeHistory.unshift({ time: activeTrade.time, action: activeTrade.action, entry: activeTrade.entry, tp: activeTrade.tp, sl: activeTrade.sl, result, pnl_pct }); 
        totalPnl += pnl_pct; 
        if (tradeHistory.length > 50) tradeHistory.pop(); 
    } 
    activeTrade = null; setTpSlLines(null, null, null); 
    saveSimState(); updateTradeStats(); renderTradesTable(); 
}

function updatePriceStats() {
  const el = document.getElementById('stat-price');
  const hdrEl = document.getElementById('hdr-price');
  const p = stats.price;
  if (!p) return;
  el.textContent = p.toLocaleString('en', {minimumFractionDigits: 2, maximumFractionDigits: 6});
  hdrEl.textContent = p.toLocaleString('en', {minimumFractionDigits: 2, maximumFractionDigits: 6});
  document.getElementById('stat-atr').textContent = stats.atr ? `ATR ${stats.atr.toFixed(4)}` : 'ATR --';
  if (stats.prevPrice && stats.prevPrice !== p) {
    const up = p > stats.prevPrice;
    el.className = 'stat-value ' + (up ? 'up' : 'down');
    hdrEl.className = 'live-price ' + (up ? 'up' : 'down');
  }
}

// [FIX-1] OI display — validasi timestamp lebih ketat
function updateOIStats() {
  const v = stats.oi;
  if (!v || isNaN(v)) return;

  // Sanity check: nilai seperti Unix timestamp = bukan OI
  if (isLikelyTimestamp(v)) {
    document.getElementById('stat-oi').textContent = '—';
    document.getElementById('stat-oi-time').textContent = 'data err';
    return;
  }
  
  let fmt;
  if (v >= 1e9) fmt = (v/1e9).toFixed(2) + 'B';
  else if (v >= 1e6) fmt = (v/1e6).toFixed(2) + 'M';
  else if (v >= 1e3) fmt = (v/1e3).toFixed(1) + 'K';
  else fmt = v.toFixed(0);
  
  document.getElementById('stat-oi').textContent = fmt;
  document.getElementById('stat-oi-time').textContent = stats.oiTime || '--';
}

function updateLSRStats() {
  if (!stats.lsr) return;
  document.getElementById('stat-lsr').textContent = stats.lsr.toFixed(4);
  const b = document.getElementById('stat-bias');
  b.textContent = stats.bias.split('_')[0];
  b.className = 'bias-badge ' + stats.bias;
}

function updateBalanceStats() {
  if (!stats.balance) return;
  document.getElementById('stat-balance').childNodes[0].nodeValue = stats.balance.toLocaleString('en', {maximumFractionDigits: 2}) + ' USDT ';
  document.getElementById('stat-risk').textContent = 'Risk ' + (stats.risk_pct * 100).toFixed(1) + '% / trade';
  if (stats.initBalance && stats.balance !== stats.initBalance) {
    const diff = ((stats.balance - stats.initBalance) / stats.initBalance) * 100;
    const span = document.getElementById('stat-bal-pct');
    span.textContent = `(${diff > 0 ? '+' : ''}${diff.toFixed(2)}%)`;
    span.style.color = diff > 0 ? 'var(--accent)' : 'var(--danger)';
  }
}

function updateTradeStats() {
  const wins = tradeHistory.filter(t => t.result === 'WIN').length;
  const total = tradeHistory.length;
  const wr = total ? (wins / total * 100).toFixed(1) : '--';
  const pnlStr = totalPnl >= 0 ? '+' + totalPnl.toFixed(2) : totalPnl.toFixed(2);
  const wrEl = document.getElementById('stat-winrate');
  const pnlEl = document.getElementById('stat-pnl');
  wrEl.textContent = total ? wr + '%' : '--';
  wrEl.className = 'stat-value ' + (total ? (wins/total >= 0.5 ? 'up' : 'down') : '');
  pnlEl.textContent = total ? pnlStr + '%' : '+0.00%';
  pnlEl.className = 'stat-value ' + (totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : '');
  document.getElementById('stat-trades').textContent = total + ' closed' + (activeTrade ? '   1 open' : '');
  document.getElementById('stat-pnl-sub').textContent = signalCount + ' signals fired';
}

function _loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });
}

async function initChart() {
   if (_lwChart) return;
   
   const _LC_CDNS = [
     '/lw-charts.js',
     'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js',
     'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js'
   ];
   
   let loaded = false;
   for (const src of _LC_CDNS) {
     try { 
         await _loadScript(src); 
         if (typeof LightweightCharts !== 'undefined') { loaded = true; break; } 
     } catch(e) {}
   }
   
   if (!loaded) { document.getElementById('chart-status').textContent = '⚠ lib load failed'; return; }
   
   const wrapper = document.getElementById('chart-wrapper');
   const container = document.getElementById('chart-container');
   if (!container || !wrapper) return;
   
   const emptyEl = document.getElementById('chart-empty');
   if (emptyEl) emptyEl.style.display = 'none';
   
   _lwChart = LightweightCharts.createChart(container, {
     autoSize: true,
     layout: { background: { type: 'solid', color: '#0d1117' }, textColor: '#8b949e' },
     grid: { vertLines: { color: '#1a2030' }, horzLines: { color: '#1a2030' } },
     crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
     rightPriceScale: { borderColor: '#30363d' },
     timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
     handleScroll: { mouseWheel: true, pressedMouseMove: true },
     handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
   });
   
   _candleSeries = _lwChart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderUpColor: '#26a69a', borderDownColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
   _volSeries = _lwChart.addHistogramSeries({ color: '#3b82f620', priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
   _lwChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
   
   const ro = new ResizeObserver(entries => {
     if(entries.length === 0 || entries[0].target !== wrapper) return;
     const newRect = entries[0].contentRect;
     if (_lwChart && newRect.width > 0 && newRect.height > 0 && !isChartHidden) {
       _lwChart.applyOptions({ width: newRect.width, height: newRect.height });
     }
   });
   ro.observe(wrapper);
   
   _chartReady = true;
}

async function fetchOHLCV(tf) {
   const sym = _getLiveSymbol();
   const intv = tf || _currentTf;
   const url = `https://api.bytick.com/v5/market/kline?category=linear&symbol=${sym}&interval=${intv}&limit=200`;
   const statusEl = document.getElementById('chart-status');
   try {
     const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
     if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
     const data = await resp.json();
     if (data.retCode !== 0) throw new Error(data.retMsg || 'API error');
     const rows = data.result?.list;
     if (!rows?.length) throw new Error('empty kline list');
     const candles = rows.slice().reverse().map(r => ({ time: Math.floor(parseInt(r[0]) / 1000), open: parseFloat(r[1]), high: parseFloat(r[2]), low: parseFloat(r[3]), close: parseFloat(r[4]), volume: parseFloat(r[5]) }));
     _ohlcvCache[intv] = candles; _lastCandleTs = candles[candles.length - 1]?.time || 0;
     if (statusEl) { statusEl.textContent = `✓ ${sym} ${_tfLabel(intv)}`; statusEl.className = 'chart-status ok'; }
     return candles;
   } catch(e) {
     if (statusEl) { statusEl.textContent = `✗ ${e.message}`; statusEl.className = 'chart-status err'; } return null;
   }
}

function _tfLabel(tf) { const m = {'1':'1m','3':'3m','5':'5m','15':'15m','30':'30m','60':'1h','120':'2h','240':'4h','D':'1d'}; return m[tf] || tf; }

function renderCandles(candles) {
  if (!_candleSeries || !candles?.length) return;
  _candleSeries.setData(candles);
  _volSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? '#26a69a30' : '#ef535030' })));
  _resetLiveCandle && _resetLiveCandle();
  _lastCandleTs = candles[candles.length - 1]?.time || _lastCandleTs;
  _applyMarkers();
  _lwChart.timeScale().scrollToRealTime();
}

let _liveCandle = null;
function updateLiveCandle(price) {
  if (!_candleSeries || !_lastCandleTs) return;
  const tf = parseInt(_currentTf) || 5; const tfSec = tf * 60;
  const now = Math.floor(Date.now() / 1000);
  const candleTs = Math.floor(now / tfSec) * tfSec;
  try {
    if (!_liveCandle || candleTs > _liveCandle.ts) {
      _liveCandle = { ts: candleTs, open: price, high: price, low: price, close: price };
      _candleSeries.update({ time: candleTs, open: price, high: price, low: price, close: price });
      _volSeries.update({ time: candleTs, value: 0, color: '#3b82f620' });
      _lastCandleTs = candleTs;
    } else {
      _liveCandle.close = price;
      if (price > _liveCandle.high) _liveCandle.high = price;
      if (price < _liveCandle.low) _liveCandle.low = price;
      _candleSeries.update({ time: _liveCandle.ts, open: _liveCandle.open, high: _liveCandle.high, low: _liveCandle.low, close: _liveCandle.close });
    }
  } catch(e) {}
}

function _resetLiveCandle() { _liveCandle = null; }

let _pendingMarkers = [];

// [FIX-4] addSignalMarker dengan retry kalau chart belum ready
function addSignalMarker(action, price) {
  const tf = parseInt(_currentTf) || 5; const tfSec = tf * 60;
  const now = Math.floor(Date.now() / 1000);
  const ts = Math.floor(now / tfSec) * tfSec;
  _pendingMarkers.push({ time: ts, type: action });
  if (_pendingMarkers.length > 50) _pendingMarkers.shift();
  priceHistory.push({ price, time: Date.now(), signal: action });
  if (priceHistory.length > MAX_CHART_POINTS) priceHistory.shift();
  // Retry apply dengan sedikit delay kalau chart belum siap
  if (_candleSeries && _lastCandleTs) {
    _applyMarkers();
  } else {
    setTimeout(_applyMarkers, 1500);
  }
}

// [FIX-4] _applyMarkers dengan null guard
function _applyMarkers() {
  if (!_candleSeries || !_pendingMarkers.length) return;
  try {
    const markers = _pendingMarkers.map(m => ({
      time: m.time, position: m.type === 'BUY' ? 'belowBar' : 'aboveBar',
      color: m.type === 'BUY' ? '#00e5a0' : '#ef4444',
      shape: m.type === 'BUY' ? 'arrowUp' : 'arrowDown', text: m.type, size: 1.5
    }));
    _candleSeries.setMarkers(markers);
  } catch(e) { console.warn('setMarkers error:', e); }
}

let _tpLine = null, _slLine = null, _entryLine = null;
function setTpSlLines(entry, tp, sl) {
   if (!_candleSeries) return;
   if (_entryLine) { try { _candleSeries.removePriceLine(_entryLine); } catch(e) {} _entryLine = null; }
   if (_tpLine) { try { _candleSeries.removePriceLine(_tpLine); } catch(e) {} _tpLine = null; }
   if (_slLine) { try { _candleSeries.removePriceLine(_slLine); } catch(e) {} _slLine = null; }
   if (entry) _entryLine = _candleSeries.createPriceLine({ price: entry, color: '#3b82f6', lineWidth: 1, lineStyle: 0, title: 'ENTRY' });
   if (tp) _tpLine = _candleSeries.createPriceLine({ price: tp, color: '#00e5a070', lineWidth: 1, lineStyle: 2, title: 'TP' });
   if (sl) _slLine = _candleSeries.createPriceLine({ price: sl, color: '#ef444470', lineWidth: 1, lineStyle: 2, title: 'SL' });
}

async function setTimeframe(btn) {
  document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); _currentTf = btn.dataset.tf;
  const cached = _ohlcvCache[_currentTf];
  if (cached) renderCandles(cached);
  const fresh = await fetchOHLCV(_currentTf);
  if (fresh) renderCandles(fresh);
}

function addPricePoint(price, signal, tp, sl) {
  priceHistory.push({ price, time: Date.now(), signal, tp, sl });
  if (priceHistory.length > MAX_CHART_POINTS) priceHistory.shift();
  updateLiveCandle(price);
  const emptyEl = document.getElementById('chart-empty');
  if (emptyEl) emptyEl.style.display = 'none';
}

let _ohlcvRefreshTimer = null;
function _scheduleOHLCVRefresh() {
  if (_ohlcvRefreshTimer) clearInterval(_ohlcvRefreshTimer);
  const intervalMs = (parseInt(_currentTf) >= 60) ? 300_000 : 30_000;
  _ohlcvRefreshTimer = setInterval(async () => {
    const candles = await fetchOHLCV(_currentTf);
    if (candles) renderCandles(candles);
  }, intervalMs);
}

async function startChart() {
   await initChart();
   if (!_chartReady) return;
   const candles = await fetchOHLCV(_currentTf);
   if (candles) renderCandles(candles);
   _scheduleOHLCVRefresh();
}
startChart();

// ── Chart price lines dari Go engine API ─────────────────────────────────────
let _chartLines = [];

async function fetchPositions() {
    if (!_candleSeries) return;
    try {
        const r = await fetch('/api/positions');
        if (!r.ok) return;
        const d = await r.json();
        
        if (_chartLines.length > 0) {
            _chartLines.forEach(l => { 
                try { _candleSeries.removePriceLine(l); } catch(e) {} 
            });
            _chartLines = [];
        }

        if (d.active && d.active.length > 0) {
            const pos = d.active[0];
            const upColor   = '#00e5a0';
            const downColor = '#ef4444';
            
            try {
                _chartLines.push(_candleSeries.createPriceLine({ price: pos.entry_price, color: '#3b82f6', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `ENTRY ${pos.side}` }));
                _chartLines.push(_candleSeries.createPriceLine({ price: pos.take_profit, color: upColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP' }));
                _chartLines.push(_candleSeries.createPriceLine({ price: pos.stop_loss, color: downColor, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'SL' }));
            } catch(e) {}
            
            renderTradesTableGo(d.active, d.history || []);
        } else {
            renderTradesTableGo([], d.history || []);
        }
    } catch (e) {
        // Bot mungkin tidak running, skip
    }
}

function renderTradesTableGo(active, history) {
    const tbody = document.getElementById('trades-tbody');
    if (!tbody) return;
    
    let html = '';
    
    if (active && active.length > 0) {
        const p = active[0];
        const cls = p.side === 'BUY' ? 'trade-win' : 'trade-loss';
        const pnlColor = (p.pnl || 0) >= 0 ? 'trade-win' : 'trade-loss';
        const pnlSign = (p.pnl || 0) >= 0 ? '+' : '';
        html += `
            <tr style="background: rgba(30, 41, 59, 0.5)">
                <td>${p.time || '--'}</td>
                <td class="${cls}">${p.side} (LIVE)</td>
                <td>${(p.entry_price||0).toFixed(4)}</td>
                <td class="trade-win">${(p.take_profit||0).toFixed(4)}</td>
                <td class="trade-loss">${(p.stop_loss||0).toFixed(4)}</td>
                <td style="color:var(--accent)">OPEN</td>
                <td class="${pnlColor}" style="font-weight:bold">${pnlSign}${(p.pnl||0).toFixed(2)}%</td>
            </tr>
        `;
    }
    
    if (history && history.length > 0) {
        history.slice(0, 20).forEach(p => {
             const cls = p.side === 'BUY' ? 'trade-win' : 'trade-loss';
             const pnlColor = (p.pnl || 0) >= 0 ? 'trade-win' : 'trade-loss';
             const pnlSign = (p.pnl || 0) >= 0 ? '+' : '';
             html += `
                <tr>
                    <td>${p.time || '--'}</td>
                    <td class="${cls}">${p.side}</td>
                    <td>${(p.entry_price||0).toFixed(4)}</td>
                    <td>${(p.take_profit||0).toFixed(4)}</td>
                    <td>${(p.stop_loss||0).toFixed(4)}</td>
                    <td class="${cls}">${p.status || '--'}</td>
                    <td class="${pnlColor}">${pnlSign}${(p.pnl||0).toFixed(2)}%</td>
                </tr>
            `;
        });
    }
    
    if (html === '') {
        html = '<tr><td colspan="7" style="text-align:center; padding: 2rem; color:#64748B;">No trades yet — Start bot to begin paper trading</td></tr>';
    }
    
    tbody.innerHTML = html;
}

// [FIX-5] renderTradesTable — hapus guard yang block render pas Go API available
function renderTradesTable() {
    const tbody = document.getElementById('trades-tbody');
    if (!tbody) return;
    // Kalau Go API punya active position, skip (biar Go yang handle)
    if (_chartLines.length > 0 && (activeTrade === null && tradeHistory.length === 0)) return;
    if (!tradeHistory.length && !activeTrade) {
      tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text2);text-align:center;padding:10px">Belum ada trade</td></tr>';
      return;
    }
    let rows = '';
    if (activeTrade) {
      rows += `<tr><td>${activeTrade.time}</td><td class="trade-open">${activeTrade.action}</td><td>${activeTrade.entry.toFixed(4)}</td><td class="trade-win">${activeTrade.tp.toFixed(4)}</td><td class="trade-loss">${activeTrade.sl.toFixed(4)}</td><td class="trade-open">OPEN</td><td class="trade-open">--</td></tr>`;
    }
    tradeHistory.slice(0, 20).forEach(t => {
      const cls = t.result === 'WIN' ? 'trade-win' : 'trade-loss';
      const pnl = (t.pnl_pct >= 0 ? '+' : '') + t.pnl_pct.toFixed(2) + '%';
      rows += `<tr><td>${t.time}</td><td class="${cls}">${t.action}</td><td>${t.entry.toFixed(4)}</td><td>${t.tp.toFixed(4)}</td><td>${t.sl.toFixed(4)}</td><td class="${cls}">${t.result}</td><td class="${cls}">${pnl}</td></tr>`;
    });
    tbody.innerHTML = rows;
}

function switchTab(name, btn) {
   document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
   document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
   btn.classList.add('active');
   document.getElementById('pane-' + name).classList.add('active');
   document.getElementById('log-filter-btns').style.display = name === 'logs' ? 'flex' : 'none';
   if (name === 'chart') {
     setTimeout(() => {
       if (_lwChart && !isChartHidden) {
         const c = document.getElementById('chart-container');
         if (c.clientWidth > 0) {
          _lwChart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
         }
      }
     }, 50);
   }
   if (name === 'insight') {
     // AI SIGNAL pane - ensure scanner is init
     ensureSignalPaneReady();
   }
}

function setFilter(btn) {
  document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active'); filterLevel = btn.dataset.lvl; renderLogs();
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  const btn = document.getElementById('btn-autoscroll');
  btn.style.borderColor = autoScroll ? 'var(--accent)' : '';
  btn.style.color = autoScroll ? 'var(--accent)' : '';
  if (autoScroll) renderLogs();
}

async function clearLogs() {
  try { await fetch('/api/clear-logs', { method: 'POST' }); } catch(e) {}
  logs = []; lastCount = 0; renderLogs();
}

function renderLogs() {
  const container = document.getElementById('log-container');
  const filtered = filterLevel === 'ALL' ? logs : logs.filter(l => l.level === filterLevel);
  if (!filtered.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">◈</div><div>Tidak ada log untuk filter ini</div></div>'; return;
  }
  const frag = document.createDocumentFragment();
  filtered.forEach(l => {
    const row = document.createElement('div');
    row.className = 'log-entry ' + l.level;
    row.innerHTML = `<span class="log-ts">${l.ts}</span><span class="log-lvl">${l.level}</span><span class="log-name">${l.name}</span><span class="log-msg">${escHtml(l.msg)}</span>`;
    frag.appendChild(row);
  });
  container.innerHTML = ''; container.appendChild(frag);
  if (autoScroll) container.scrollTop = container.scrollHeight;
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function toast(msg, ok=true) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show ' + (ok ? 'ok' : 'err');
  setTimeout(() => { el.className = 'toast'; }, 3000);
}

async function poll() {
  try {
    const r = await fetch('/api/logs?since=' + lastCount);
    const d = await r.json();
    if (d.logs && d.logs.length) {
      d.logs.forEach(parseLog);
      logs = [...logs, ...d.logs].slice(-500); 
      lastCount = d.total; 
      if (autoScroll) { renderLogs(); }
    }
    updateStatus(d.running);
  } catch(e) {}
}

function updateStatus(running) {
   const dot = document.getElementById('status-dot');
   const txt = document.getElementById('status-text');
   const btnS = document.getElementById('btn-start');
   const btnP = document.getElementById('btn-stop');
   dot.className = 'dot ' + (running ? 'running' : 'stopped');
   txt.textContent = running ? 'RUNNING' : 'STOPPED';
   btnS.disabled = running; btnP.disabled = !running;
   document.querySelectorAll('#config-form input, #config-form select').forEach(el => { el.disabled = running; });
}

async function startBot() {
  try {
    const r = await fetch('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(collectEnv()) });
    const d = await r.json(); toast(d.message, d.ok);
  } catch(e) { toast('Koneksi gagal', false); }
}

async function stopBot() {
  try {
    const r = await fetch('/api/stop', { method: 'POST' });
    const d = await r.json(); toast(d.message, d.ok);
  } catch(e) { toast('Koneksi gagal', false); }
}

const _KEY_SENTINEL = '__UNCHANGED__';

function saveToLocal() {
  const state = {
    SYMBOL: document.getElementById('cfg-symbol').value, EXCHANGE: document.getElementById('cfg-exchange').value,
    EXCHANGE_MODE: document.getElementById('cfg-mode').value, TRADING_STYLE: document.getElementById('cfg-style').value,
    TARGET_TYPE: document.getElementById('cfg-target-type').value, LEVERAGE: document.getElementById('cfg-leverage').value,
    RISK_PCT: document.getElementById('cfg-risk').value, USE_MOCK_OHLCV: document.getElementById('cfg-mock').checked,
    DRY_RUN: document.getElementById('cfg-dryrun').checked
  };
  Storage.set('botUIState', state);
}

document.querySelectorAll('input, select').forEach(el => { el.addEventListener('change', () => { saveConfig(); }); });

function collectEnv() {
  function keyVal(id) { const v = document.getElementById(id).value; return (v && v !== _KEY_SENTINEL) ? v : ''; }
  return {
    SYMBOL: document.getElementById('cfg-symbol').value.trim(), LEVERAGE: document.getElementById('cfg-leverage').value,
    EXCHANGE: document.getElementById('cfg-exchange').value, EXCHANGE_MODE: document.getElementById('cfg-mode').value,
    TRADING_STYLE: document.getElementById('cfg-style').value, TARGET_TYPE: document.getElementById('cfg-target-type').value,
    RISK_PCT: (parseInt(document.getElementById('cfg-risk').value) / 100).toString(), USE_MOCK_OHLCV: document.getElementById('cfg-mock').checked ? '1' : '0',
    DRY_RUN: document.getElementById('cfg-dryrun').checked ? '1' : '0', BYBIT_DEMO_API_KEY: keyVal('key-bybit-demo-key'),
    BYBIT_DEMO_API_SECRET: keyVal('key-bybit-demo-secret'), BYBIT_REAL_API_KEY: keyVal('key-bybit-real-key'),
    BYBIT_REAL_API_SECRET: keyVal('key-bybit-real-secret'), MEXC_API_KEY: keyVal('key-mexc-key'), MEXC_API_SECRET: keyVal('key-mexc-secret')
  };
}

async function saveConfig() {
   try {
     saveToLocal();
     const r = await fetch('/api/save-env', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(collectEnv()) });
     const d = await r.json(); toast(d.message, d.ok);
   } catch(e) { toast('Koneksi gagal', false); }
}

async function loadConfig() {
  try {
    const r = await fetch('/api/get-env'); const d = await r.json(); const e = d.env || {};
    let local = Storage.get('botUIState', {});
    
    const SYMBOL = local.SYMBOL || e.SYMBOL;
    if (SYMBOL) { 
       const sym = SYMBOL.replace('_',''); const sel = document.getElementById('cfg-symbol');
       if ([...sel.options].some(o => o.value === sym)) { sel.value = sym; } else { sel.dataset.pendingSymbol = sym; }
       document.getElementById('hdr-symbol').textContent = sym; 
     }
    
    if (local.LEVERAGE || e.LEVERAGE) {
      document.getElementById('cfg-leverage').value = local.LEVERAGE || e.LEVERAGE;
      document.getElementById('cfg-lev-slider').value = local.LEVERAGE || e.LEVERAGE;
      document.getElementById('lev-val-display').textContent = (local.LEVERAGE || e.LEVERAGE) + 'x';
    }
    
    if (local.EXCHANGE || e.EXCHANGE) document.getElementById('cfg-exchange').value = local.EXCHANGE || e.EXCHANGE;
    if (local.EXCHANGE_MODE || e.EXCHANGE_MODE) document.getElementById('cfg-mode').value = local.EXCHANGE_MODE || e.EXCHANGE_MODE;
    if (local.TRADING_STYLE || e.TRADING_STYLE) document.getElementById('cfg-style').value = local.TRADING_STYLE || e.TRADING_STYLE;
    if (local.TARGET_TYPE || e.TARGET_TYPE) document.getElementById('cfg-target-type').value = local.TARGET_TYPE || e.TARGET_TYPE;
    
    let riskRaw = local.RISK_PCT || e.RISK_PCT;
    if (riskRaw) { 
        let pct = parseInt(riskRaw);
        if (parseFloat(riskRaw) < 1.0) pct = Math.round(parseFloat(riskRaw) * 100);
        if (pct < 1) pct = 1; if (pct > 100) pct = 100;
        document.getElementById('cfg-risk').value = pct; 
        document.getElementById('risk-val-display').textContent = pct + '%';
        stats.risk_pct = pct / 100.0; 
     }
    
    if (local.USE_MOCK_OHLCV !== undefined) document.getElementById('cfg-mock').checked = local.USE_MOCK_OHLCV;
    else if (e.USE_MOCK_OHLCV) document.getElementById('cfg-mock').checked = e.USE_MOCK_OHLCV === '1';
    if (local.DRY_RUN !== undefined) document.getElementById('cfg-dryrun').checked = local.DRY_RUN;
    else if (e.DRY_RUN) document.getElementById('cfg-dryrun').checked = e.DRY_RUN === '1';

    function loadKey(id, val) { 
        if (!val) return; 
        const el = document.getElementById(id); el.value = val; el.placeholder = '••••' + val.slice(-4); 
        el.addEventListener('focus', function() { if (el.value === val) el.value = ''; }, {once:true}); 
        el.addEventListener('blur', function() { if (el.value === '') el.value = val; }); 
    }
    loadKey('key-bybit-demo-key', e.BYBIT_DEMO_API_KEY); loadKey('key-bybit-demo-secret', e.BYBIT_DEMO_API_SECRET);
    loadKey('key-bybit-real-key', e.BYBIT_REAL_API_KEY); loadKey('key-bybit-real-secret', e.BYBIT_REAL_API_SECRET);
    loadKey('key-mexc-key', e.MEXC_API_KEY); loadKey('key-mexc-secret', e.MEXC_API_SECRET);
    
    updateLeverageLimits();
  } catch(e) {}
}

const _BYBIT_INSTRUMENTS_URL = 'https://api.bytick.com/v5/market/instruments-info';
async function loadBybitPairs(exchange) {
  const statusEl = document.getElementById('pairs-status'); const sel = document.getElementById('cfg-symbol');
  if (!statusEl || !sel) return;
  if (exchange && exchange !== 'bybit') { 
     statusEl.textContent = 'MEXC – manual'; statusEl.style.color = 'var(--warn)';
     sel.innerHTML = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','PEPEUSDT','WIFUSDT'].map(s => `<option value="${s}">${s}</option>`).join('');
     sel.onchange = () => { _onSymbolChange(sel.value); };
     return;
  }
  statusEl.textContent = '⟳ fetching…'; statusEl.style.color = 'var(--text2)';
  try {
    const params = new URLSearchParams({ category: 'linear', status: 'Trading', limit: '1000' });
    const res = await fetch(`${_BYBIT_INSTRUMENTS_URL}?${params}`); const data = await res.json();
    if (data.retCode !== 0) throw new Error(data.retMsg);
    const pairs = data.result.list.filter(p => p.quoteCoin === 'USDT' && p.status === 'Trading').map(p => p.symbol).sort();
    if (!pairs.length) throw new Error('Empty pair list');
    const pending = sel.dataset.pendingSymbol || sel.value;
    sel.innerHTML = pairs.map(sym => `<option value="${sym}"${sym === pending ? ' selected' : ''}>${sym}</option>`).join('');
    if (pending && pairs.includes(pending)) { sel.value = pending; document.getElementById('hdr-symbol').textContent = pending; }
    else if (!pending && pairs.includes('BTCUSDT')) { sel.value = 'BTCUSDT'; }
    delete sel.dataset.pendingSymbol; 
    statusEl.textContent = `✓ ${pairs.length} pairs`; 
    statusEl.style.color = 'var(--accent)';
    document.getElementById('hdr-symbol').textContent = sel.value;
    sel.onchange = () => { _onSymbolChange(sel.value); };
  } catch(err) { statusEl.textContent = '✗ fetch failed'; statusEl.style.color = 'var(--danger)'; }
}

function _onSymbolChange(sym) {
    document.getElementById('hdr-symbol').textContent = sym;
    const btn = document.querySelector('.tf-btn.active') || document.querySelector('.tf-btn[data-tf="5"]');
    if (btn) setTimeframe(btn);
    if (typeof connectLivePriceWS === 'function') connectLivePriceWS();
    updateLeverageLimits(); saveConfig();
    _ohlcvCache = {};
    if (_candleSeries) try { _candleSeries.setData([]); } catch(e) {}
    if (_volSeries) try { _volSeries.setData([]); } catch(e) {}
    _pendingMarkers = [];
    stats.price = null; stats.prevPrice = null;
    document.getElementById('hdr-price').textContent = "--";
    document.getElementById('stat-price').textContent = "--";
}

function onExchangeChange(val) { loadBybitPairs(val); updateLeverageLimits(); saveConfig(); }

let _wsTicker = null;
function _getLiveSymbol() { const sel = document.getElementById('cfg-symbol'); return (sel && sel.value) ? sel.value.replace('_','') : 'BTCUSDT'; }

function connectLivePriceWS() {
  const sym = _getLiveSymbol(); 
  if (_wsTicker) { _wsTicker.close(); _wsTicker = null; }
  _wsTicker = new WebSocket('wss://stream.bytick.com/v5/public/linear');
  _wsTicker.onopen = () => _wsTicker.send(JSON.stringify({"op": "subscribe", "args": [`tickers.${sym}`]}));
  _wsTicker.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      if (data?.topic === `tickers.${sym}` && data?.data) {
        const ticker = data.data; 
        
        if (ticker.lastPrice !== undefined) {
            const price = parseFloat(ticker.lastPrice);
            if (price && !isNaN(price)) {
                stats.prevPrice = stats.price; stats.price = price; 
                addPricePoint(price, null, null, null); 
                if (activeTrade) checkTradeOutcome(price); 
                updatePriceStats();
            }
        }
        
        // [FIX-2] Percentage SELALU dari WS ticker, kalikan 100 (Bybit WS selalu decimal form)
        if (ticker.price24hPcnt !== undefined) {
            const raw = parseFloat(ticker.price24hPcnt);
            if (!isNaN(raw)) {
                const pct24h = raw * 100;
                const deltaEl = document.getElementById('hdr-delta');
                if (deltaEl) {
                    const sign = pct24h >= 0 ? '+' : '';
                    deltaEl.textContent = `${sign}${pct24h.toFixed(2)}% 24h`;
                    deltaEl.className = 'price-delta ' + (pct24h >= 0 ? 'up' : 'down');
                    deltaEl.style.display = '';
                }
            }
        }
      }
    } catch(e) {}
  };
  _wsTicker.onclose = () => setTimeout(connectLivePriceWS, 3000);
}

// [FIX-2] fetchAIInsight: pct_24h dari bot_insight TIDAK dipakai utk header delta
async function fetchAIInsight() {
  try {
    const r = await fetch('/api/insight'); const d = await r.json();
    
    // Hanya update OI dari bot_insight kalau nilainya valid (bukan timestamp)
    if (d.open_interest && !isLikelyTimestamp(d.open_interest)) { 
        stats.oi = d.open_interest; 
        stats.oiTime = d.timestamp; 
        updateOIStats();
    }
    if (d.lsr_val) { 
        stats.lsr = d.lsr_val; 
        let biasTxt = 'NEUTRAL'; 
        if (d.lsr_val > 1.05) biasTxt = 'LONG_HEAVY'; 
        else if (d.lsr_val < 0.95) biasTxt = 'SHORT_HEAVY'; 
        stats.bias = biasTxt; 
        updateLSRStats(); 
    }
    if (d.balance > 0) {
        stats.balance = d.balance;
        if (!stats.initBalance) {
            const savedBal = Storage.get('botInitBalance');
            if (savedBal) stats.initBalance = parseFloat(savedBal); 
            else { stats.initBalance = d.balance; Storage.set('botInitBalance', d.balance); }
        }
        updateBalanceStats();
    }
    if (d.last_price && !stats.price) { stats.price = d.last_price; updatePriceStats(); }
    
    // [FIX-2] TIDAK update hdr-delta dari bot_insight.pct_24h — itu ATR/price bukan 24h change!
    // pct_24h dari bot_insight = (atr/price)*100 = volatility, bukan perubahan harga 24 jam.
    // 24h% yang benar sudah dihandle oleh WS ticker di connectLivePriceWS.
    
  } catch(e) {}
}


// ═══════════════════════════════════════════════════════════════════
// [FIX-3] AI SIGNAL SCANNER — Independent, langsung ke Bybit publik
// Jalan tanpa bot, auto-update setiap 5 menit
// ═══════════════════════════════════════════════════════════════════

const AI_SIGNAL_PAIRS = [
    'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT',
    'DOGEUSDT','PEPEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT',
    'DOTUSDT','MATICUSDT','LTCUSDT','UNIUSDT','ATOMUSDT'
];
let _aiSignalTimer = null;
let _aiSignalPaneReady = false;

// Inisialisasi pane AI SIGNAL (replace konten static dari HTML)
function ensureSignalPaneReady() {
    if (_aiSignalPaneReady) return;
    _aiSignalPaneReady = true;
    const pane = document.getElementById('pane-insight');
    if (!pane) return;
    
    pane.style.padding = '0';
    pane.style.background = 'var(--bg)';
    pane.innerHTML = `
        <div style="padding:16px;height:100%;overflow-y:auto;box-sizing:border-box;">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--border);padding-bottom:12px;">
                <div>
                    <div style="font-family:var(--mono);color:var(--accent);font-size:13px;font-weight:600;letter-spacing:2px;">🎯 AI SIGNAL SCANNER</div>
                    <div style="font-family:var(--mono);font-size:9px;color:var(--text2);margin-top:3px;">Independent • Langsung ke Bybit • Tanpa bot</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                    <span id="ai-scan-status" style="font-family:var(--mono);font-size:10px;color:var(--text2);">⟳ idle</span>
                    <select id="ai-signal-tf" style="width:auto;padding:4px 8px;font-size:11px;background:var(--panel);border:1px solid var(--border2);color:var(--text);border-radius:4px;">
                        <option value="5" selected>5m</option>
                        <option value="15">15m</option>
                        <option value="60">1h</option>
                        <option value="240">4h</option>
                    </select>
                    <button onclick="runAISignalScan()" style="padding:6px 14px;background:var(--accent);color:#000;border:none;border-radius:4px;font-family:var(--mono);font-size:11px;font-weight:700;cursor:pointer;letter-spacing:1px;">⚡ SCAN</button>
                    <button onclick="toggleAutoScan()" id="btn-auto-scan" style="padding:6px 10px;background:var(--panel);border:1px solid var(--border2);color:var(--text2);border-radius:4px;font-family:var(--mono);font-size:10px;cursor:pointer;">AUTO: OFF</button>
                </div>
            </div>
            
            <!-- Stats bar -->
            <div id="ai-signal-stats" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px;"></div>
            
            <!-- Signal cards grid -->
            <div id="ai-signal-grid" style="display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));">
                <div style="color:var(--text2);font-family:var(--mono);font-size:12px;padding:30px;text-align:center;grid-column:1/-1;border:1px dashed var(--border);border-radius:6px;">
                    Klik <strong style="color:var(--accent)">⚡ SCAN</strong> untuk mulai analisa ${AI_SIGNAL_PAIRS.length} pair sekaligus
                </div>
            </div>
        </div>
    `;
    
    // Update tab label
    const tabBtn = document.querySelector('.tab[onclick*="insight"]');
    if (tabBtn) tabBtn.textContent = '🎯 AI SIGNAL';
}

let _autoScanActive = false;
function toggleAutoScan() {
    _autoScanActive = !_autoScanActive;
    const btn = document.getElementById('btn-auto-scan');
    if (!btn) return;
    if (_autoScanActive) {
        btn.textContent = 'AUTO: ON';
        btn.style.borderColor = 'var(--accent)';
        btn.style.color = 'var(--accent)';
        runAISignalScan();
        _aiSignalTimer = setInterval(runAISignalScan, 5 * 60 * 1000);
    } else {
        btn.textContent = 'AUTO: OFF';
        btn.style.borderColor = 'var(--border2)';
        btn.style.color = 'var(--text2)';
        if (_aiSignalTimer) { clearInterval(_aiSignalTimer); _aiSignalTimer = null; }
    }
}

// ── Indikator teknikal (client-side) ─────────────────────────────────────────

function _calcRSI(closes, period = 14) {
    if (closes.length < period + 2) return 50;
    const deltas = closes.slice(1).map((v, i) => v - closes[i]);
    let gains = 0, losses = 0;
    for (let i = 0; i < period; i++) {
        if (deltas[i] > 0) gains += deltas[i]; else losses -= deltas[i];
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period; i < deltas.length; i++) {
        const up = deltas[i] > 0 ? deltas[i] : 0;
        const dn = deltas[i] < 0 ? -deltas[i] : 0;
        avgGain = (avgGain * (period - 1) + up) / period;
        avgLoss = (avgLoss * (period - 1) + dn) / period;
    }
    return avgLoss < 1e-9 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

function _calcEMA(closes, period) {
    if (closes.length < period) return closes[closes.length - 1] || 0;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
    return ema;
}

function _calcATR(candles, period = 14) {
    if (candles.length < 2) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
        const hl = candles[i].h - candles[i].l;
        const hpc = Math.abs(candles[i].h - candles[i-1].c);
        const lpc = Math.abs(candles[i].l - candles[i-1].c);
        trs.push(Math.max(hl, hpc, lpc));
    }
    const n = Math.min(period, trs.length);
    let atr = trs.slice(0, n).reduce((s, v) => s + v, 0) / n;
    for (let i = n; i < trs.length; i++) atr = atr * (n - 1) / n + trs[i] / n;
    return atr;
}

// ── Core signal analyzer ──────────────────────────────────────────────────────

function _analyzeSignal(symbol, candles) {
    if (candles.length < 35) return null;
    
    const closes = candles.map(c => c.c);
    const price = closes[closes.length - 1];
    
    const rsi  = _calcRSI(closes);
    const ema9  = _calcEMA(closes, 9);
    const ema21 = _calcEMA(closes, 21);
    const ema50 = _calcEMA(closes, 50);
    const atr   = _calcATR(candles);
    
    if (atr < 1e-8) return null;
    
    // Volume analysis (20 candle avg)
    const recentVols = candles.slice(-5).map(c => c.v);
    const histVols   = candles.slice(-25, -5).map(c => c.v);
    const avgVol     = histVols.reduce((s, v) => s + v, 0) / (histVols.length || 1);
    const lastVol    = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
    const volRatio   = lastVol / (avgVol || 1);
    
    let bullScore = 0, bearScore = 0;
    const reasons = [];
    
    // RSI evidence
    if (rsi <= 25)       { bullScore += 3; reasons.push(`RSI ${rsi.toFixed(0)} (oversold++)`); }
    else if (rsi <= 35)  { bullScore += 2; reasons.push(`RSI ${rsi.toFixed(0)} (oversold)`); }
    else if (rsi <= 45)  { bullScore += 1; }
    else if (rsi >= 75)  { bearScore += 3; reasons.push(`RSI ${rsi.toFixed(0)} (overbought++)`); }
    else if (rsi >= 65)  { bearScore += 2; reasons.push(`RSI ${rsi.toFixed(0)} (overbought)`); }
    else if (rsi >= 55)  { bearScore += 1; }
    
    // EMA alignment (trend confirmation)
    const emaBullAlign = ema9 > ema21 && ema21 > ema50;
    const emaBearAlign = ema9 < ema21 && ema21 < ema50;
    if (emaBullAlign)     { bullScore += 2; reasons.push('EMA bull align'); }
    else if (emaBearAlign){ bearScore += 2; reasons.push('EMA bear align'); }
    else if (ema9 > ema21){ bullScore += 1; }
    else                  { bearScore += 1; }
    
    // Price vs EMA50
    if (price > ema50 * 1.002) { bullScore += 1; }
    else if (price < ema50 * 0.998) { bearScore += 1; }
    
    // Volume spike confirmation
    if (volRatio > 1.8) {
        const last = candles[candles.length - 1];
        if (last.c > last.o) { bullScore += 1; reasons.push(`Vol ${volRatio.toFixed(1)}x spike`); }
        else                 { bearScore += 1; reasons.push(`Vol ${volRatio.toFixed(1)}x spike`); }
    }
    
    // Candlestick patterns
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    
    // Bullish engulfing
    if (last.c > last.o && prev.c < prev.o &&
        last.c > prev.o && last.o < prev.c) {
        bullScore += 2; reasons.push('Bullish engulf');
    }
    // Bearish engulfing
    if (last.c < last.o && prev.c > prev.o &&
        last.c < prev.o && last.o > prev.c) {
        bearScore += 2; reasons.push('Bearish engulf');
    }
    // Morning star (3 candle)
    if (prev2.c < prev2.o && Math.abs(prev.c - prev.o) < atr * 0.3 && last.c > last.o && last.c > (prev2.o + prev2.c) / 2) {
        bullScore += 2; reasons.push('Morning star');
    }
    // Evening star
    if (prev2.c > prev2.o && Math.abs(prev.c - prev.o) < atr * 0.3 && last.c < last.o && last.c < (prev2.o + prev2.c) / 2) {
        bearScore += 2; reasons.push('Evening star');
    }
    
    // Minimum score threshold for valid signal
    const minScore = 4;
    if (bullScore < minScore && bearScore < minScore) return null;
    if (Math.abs(bullScore - bearScore) < 2) return null; // Terlalu confusing
    
    const isBull = bullScore > bearScore;
    const direction = isBull ? 'LONG' : 'SHORT';
    const score = isBull ? bullScore : bearScore;
    const confidence = Math.min(0.95, 0.35 + score * 0.08);
    
    // TP/SL kalkulasi dengan ATR
    const slMult = 1.2;
    const tpMult = rsi < 40 || rsi > 60 ? 2.8 : 2.2; // Lebih agresif kalau momentum kuat
    
    const entry = price;
    const sl = isBull ? price - atr * slMult : price + atr * slMult;
    const tp = isBull ? price + atr * tpMult : price - atr * tpMult;
    const rr = Math.abs(tp - entry) / Math.abs(sl - entry);
    
    // Skip kalau RR kurang bagus
    if (rr < 1.5) return null;
    
    return { symbol, direction, confidence, entry, tp, sl, rr, rsi, reasons, price, ema9, ema21, volRatio };
}

// ── Main scan function ────────────────────────────────────────────────────────

async function runAISignalScan() {
    ensureSignalPaneReady();
    
    const statusEl = document.getElementById('ai-scan-status');
    const gridEl   = document.getElementById('ai-signal-grid');
    const statsEl  = document.getElementById('ai-signal-stats');
    if (!gridEl) return;
    
    const tf = document.getElementById('ai-signal-tf')?.value || '5';
    if (statusEl) statusEl.textContent = '⟳ Scanning...';
    gridEl.innerHTML = `<div style="color:var(--text2);font-family:var(--mono);font-size:12px;padding:30px;text-align:center;grid-column:1/-1;">⟳ Mengambil data ${AI_SIGNAL_PAIRS.length} pair...</div>`;
    
    const results = [];
    let scanned = 0, errors = 0;
    
    // Scan semua pair secara concurrent (batch 5 sekaligus)
    const batchSize = 5;
    for (let i = 0; i < AI_SIGNAL_PAIRS.length; i += batchSize) {
        const batch = AI_SIGNAL_PAIRS.slice(i, i + batchSize);
        const batchResults = await Promise.allSettled(batch.map(async pair => {
            const resp = await fetch(
                `https://api.bytick.com/v5/market/kline?category=linear&symbol=${pair}&interval=${tf}&limit=100`,
                { signal: AbortSignal.timeout(6000) }
            );
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const d = await resp.json();
            if (d.retCode !== 0 || !d.result?.list?.length) throw new Error('no data');
            const candles = d.result.list.slice().reverse().map(c => ({
                o: parseFloat(c[1]), h: parseFloat(c[2]),
                l: parseFloat(c[3]), c: parseFloat(c[4]), v: parseFloat(c[5])
            }));
            scanned++;
            return _analyzeSignal(pair, candles);
        }));
        
        for (const res of batchResults) {
            if (res.status === 'fulfilled' && res.value) results.push(res.value);
            else if (res.status === 'rejected') errors++;
        }
        
        // Update grid secara progressive
        if (results.length > 0) _renderAISignals(results, scanned, tf);
    }
    
    _renderAISignals(results, scanned, tf);
    _renderAIScanStats(results, scanned, errors, statsEl);
    
    const ts = new Date().toLocaleTimeString('id-ID');
    if (statusEl) statusEl.textContent = `✓ ${scanned} pair @ ${ts} | TF:${tf}m | ${results.length} signal`;
}

function _renderAIScanStats(results, total, errors, el) {
    if (!el) return;
    const longs  = results.filter(r => r.direction === 'LONG').length;
    const shorts = results.filter(r => r.direction === 'SHORT').length;
    const avgConf = results.length ? (results.reduce((s, r) => s + r.confidence, 0) / results.length * 100).toFixed(0) : 0;
    
    el.innerHTML = [
        { label: 'Scanned', value: total, color: 'var(--text)' },
        { label: 'LONG',    value: longs,  color: 'var(--accent)' },
        { label: 'SHORT',   value: shorts, color: 'var(--danger)' },
        { label: 'Avg Conf',value: avgConf + '%', color: 'var(--warn)' },
    ].map(s => `
        <div style="background:var(--bg2);border:1px solid var(--border);border-radius:4px;padding:8px;text-align:center;">
            <div style="font-size:9px;font-family:var(--mono);color:var(--text2);text-transform:uppercase;">${s.label}</div>
            <div style="font-family:var(--mono);font-size:16px;font-weight:700;color:${s.color};margin-top:2px;">${s.value}</div>
        </div>
    `).join('');
}

function _renderAISignals(results, total, tf) {
    const gridEl = document.getElementById('ai-signal-grid');
    if (!gridEl) return;
    
    if (!results.length) {
        gridEl.innerHTML = `<div style="color:var(--text2);font-family:var(--mono);font-size:12px;padding:30px;text-align:center;grid-column:1/-1;border:1px dashed var(--border);border-radius:6px;">Tidak ada sinyal kuat dari ${total} pair di TF ${tf}m.<br><span style="font-size:10px;opacity:0.6;">Coba TF lebih besar atau tunggu momentum terbentuk.</span></div>`;
        return;
    }
    
    const sorted = [...results].sort((a, b) => b.confidence - a.confidence);
    
    gridEl.innerHTML = sorted.map(s => {
        const isLong  = s.direction === 'LONG';
        const color   = isLong ? 'var(--accent)'  : 'var(--danger)';
        const bgColor = isLong ? '#00e5a012'        : '#ef444412';
        const border  = isLong ? '#00e5a030'        : '#ef444430';
        const confPct = Math.round(s.confidence * 100);
        const dec     = s.price < 0.01 ? 6 : s.price < 1 ? 5 : s.price < 10 ? 4 : s.price < 1000 ? 3 : 2;
        const confBar = `<div style="height:3px;background:var(--border);border-radius:2px;margin:6px 0 8px;">
            <div style="height:3px;width:${confPct}%;background:${color};border-radius:2px;transition:width .3s;"></div>
        </div>`;
        
        return `
        <div style="background:var(--bg2);border:1px solid ${border};border-radius:6px;padding:14px;cursor:pointer;transition:border-color .2s;" 
             onclick="selectAISignalPair('${s.symbol}')"
             onmouseenter="this.style.borderColor='${color}'"
             onmouseleave="this.style.borderColor='${border}'">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <span style="font-family:var(--mono);font-weight:700;color:var(--text);font-size:13px;">${s.symbol.replace('USDT','')}/USDT</span>
                <span style="background:${bgColor};color:${color};border:1px solid ${border};border-radius:4px;padding:3px 10px;font-family:var(--mono);font-size:11px;font-weight:700;">${s.direction}</span>
            </div>
            ${confBar}
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">
                <div style="text-align:center;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:6px;">
                    <div style="font-size:8px;color:var(--text2);text-transform:uppercase;margin-bottom:2px;">Entry</div>
                    <div style="font-family:var(--mono);color:var(--blue);font-size:11px;font-weight:600;">${s.entry.toFixed(dec)}</div>
                </div>
                <div style="text-align:center;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:6px;">
                    <div style="font-size:8px;color:var(--text2);text-transform:uppercase;margin-bottom:2px;">TP</div>
                    <div style="font-family:var(--mono);color:var(--accent);font-size:11px;font-weight:600;">${s.tp.toFixed(dec)}</div>
                </div>
                <div style="text-align:center;background:var(--panel);border:1px solid var(--border);border-radius:4px;padding:6px;">
                    <div style="font-size:8px;color:var(--text2);text-transform:uppercase;margin-bottom:2px;">SL</div>
                    <div style="font-family:var(--mono);color:var(--danger);font-size:11px;font-weight:600;">${s.sl.toFixed(dec)}</div>
                </div>
            </div>
            <div style="display:flex;justify-content:space-between;font-family:var(--mono);font-size:10px;color:var(--text2);margin-bottom:6px;">
                <span>RSI ${s.rsi.toFixed(0)}</span>
                <span>RR ${s.rr.toFixed(2)}×</span>
                <span>Conf ${confPct}%</span>
                <span>Vol ${s.volRatio.toFixed(1)}×</span>
            </div>
            <div style="font-size:9px;color:var(--text2);font-style:italic;line-height:1.4;">${s.reasons.slice(0,3).join(' · ')}</div>
        </div>`;
    }).join('');
}

// Klik signal card → pindah ke chart tab dengan pair tersebut
function selectAISignalPair(symbol) {
    const sel = document.getElementById('cfg-symbol');
    if (sel && [...sel.options].some(o => o.value === symbol)) {
        sel.value = symbol;
        _onSymbolChange(symbol);
    }
    // Switch ke chart tab
    const chartBtn = document.querySelector('.tab[onclick*="chart"]');
    if (chartBtn) {
        switchTab('chart', chartBtn);
        toast(`Pindah ke chart ${symbol}`, true);
    }
}


// ═══════════════════════════════════════════════════════════════════
// Boot sequence
// ═══════════════════════════════════════════════════════════════════

const _BYBIT_INSTRUMENTS_URL_CONST = 'https://api.bytick.com/v5/market/instruments-info';

async function loadBybitPairsConst(exchange) {
  return loadBybitPairs(exchange);
}

loadConfig();
loadSimState();
loadBybitPairs('bybit');
poll();
setInterval(poll, 1500);
setInterval(fetchAIInsight, 3000);
setTimeout(connectLivePriceWS, 1000);
setInterval(fetchPositions, 1000);
