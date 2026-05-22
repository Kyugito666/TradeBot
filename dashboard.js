let logs = []; let filterLevel = 'ALL'; let autoScroll = true; let lastCount = 0;
let _lwChart = null; let _candleSeries = null; let _volSeries = null;
let _currentTf = '5'; let _ohlcvCache = {}; let _chartReady = false; let _lastCandleTs = 0;
let priceHistory = []; const MAX_CHART_POINTS = 150;
let stats = { price: null, prevPrice: null, atr: null, oi: null, oiTime: null, lsr: null, bias: 'NEUTRAL', balance: null, initBalance: null, risk_pct: 0.03 };

let activeTrade = null; let tradeHistory = []; let signalCount = 0; let totalPnl = 0;
let isChartHidden = false;

function toggleChart() {
  isChartHidden = !isChartHidden;
  document.getElementById('chart-wrapper').style.display = isChartHidden ? 'none' : 'flex';
  document.getElementById('chart-toolbar').style.display = isChartHidden ? 'none' : 'flex';
  document.getElementById('chart-legend').style.display = isChartHidden ? 'none' : 'flex';
  document.getElementById('btn-toggle-chart').textContent = isChartHidden ? '👁️ Show Chart' : '👁️ Hide Chart';
  if (!isChartHidden && _lwChart) {
    const c = document.getElementById('chart-container');
    if (c.clientWidth > 0 && c.clientHeight > 0) {
      _lwChart.applyOptions({ width: c.clientWidth, height: c.clientHeight });
    }
  }
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
  if (parseInt(el.value) > max) { el.value = max; document.getElementById('cfg-lev-slider').value = max; document.getElementById('lev-val-display').textContent = max + 'x'; }
  saveToLocal();
}

function saveSimState() { localStorage.setItem('botSimHist', JSON.stringify({ tradeHistory, totalPnl, signalCount, activeTrade })); }
function loadSimState() {
  try {
    const d = JSON.parse(localStorage.getItem('botSimHist'));
    if(d) {
      tradeHistory = d.tradeHistory || []; totalPnl = d.totalPnl || 0; signalCount = d.signalCount || 0; activeTrade = d.activeTrade || null;
      updateTradeStats(); renderTradesTable();
    }
    const savedBal = localStorage.getItem('botInitBalance');
    if(savedBal) stats.initBalance = parseFloat(savedBal);
  } catch(e) {}
}

function resetHistory() {
  if (confirm("Reset semua histori P&L dan Win Rate di browser?")) {
    tradeHistory = []; totalPnl = 0; signalCount = 0; activeTrade = null; stats.initBalance = null;
    localStorage.removeItem('botInitBalance');
    saveSimState(); updateTradeStats(); updateBalanceStats(); renderTradesTable();
  }
}

const PARSERS = [
  { re: /\[main\] ✓ Exchange connected \| exchange=\w+ mode=\w+ \| free_USDT=([\d.]+)/, fn(m) { const b = parseFloat(m[1]); stats.balance = b; if (!stats.initBalance) { stats.initBalance = b; localStorage.setItem('botInitBalance', b); } updateBalanceStats(); } },
  { re: /Harga Real-Time \w+: ([\d.]+)/, fn(m) { const price = parseFloat(m[1]); stats.prevPrice = stats.price; stats.price = price; addPricePoint(price, null, null, null); if (activeTrade) checkTradeOutcome(price); updatePriceStats(); } },
  { re: /\[OI\]\s+\S+\s+oi=([\d.]+)/, fn(m) { stats.oi = parseFloat(m[1]); stats.oiTime = new Date().toLocaleTimeString(); updateOIStats(); } },
  { re: /\[WHALE\]\s+\S+\s+LSR=([\d.]+)\s+bias=(\w+)/, fn(m) { stats.lsr = parseFloat(m[1]); stats.bias = m[2]; updateLSRStats(); } },
  { re: /\[Executor\] entry=([\d.]+)\s+SL=([\d.]+)\s+TP=([\d.]+)\s+RR=([\d.]+)\s+conf=([\d.]+)/, fn(m) { pendingTradeParams = { entry: parseFloat(m[1]), sl: parseFloat(m[2]), tp: parseFloat(m[3]), rr: parseFloat(m[4]), conf: parseFloat(m[5]) }; } },
  { re: /\[Executor\] ── (BUY|SELL)\s/, fn(m) { pendingAction = m[1]; } },
  { re: /\[StateDB\] Saved trade row_id/, fn() { if (pendingTradeParams && pendingAction) { openDryTrade(pendingAction, pendingTradeParams); pendingTradeParams = null; pendingAction = null; } } },
  { re: /\[ConsensusEngine\] Hasil: (BUY|SELL)/, fn(m) { const action = m[1]; signalCount++; saveSimState(); updateTradeStats(); if (stats.price) addSignalMarker(action, stats.price); } },
];
let pendingTradeParams = null; let pendingAction = null;
function parseLog(log) { for (const p of PARSERS) { const m = log.msg.match(p.re); if (m) { p.fn(m, log); break; } } }

function openDryTrade(action, params) { if (activeTrade) closeTrade(null, null); activeTrade = { action, ...params, time: new Date().toLocaleTimeString() }; addSignalMarker(action, params.entry); setTpSlLines(params.entry, params.tp, params.sl); saveSimState(); updateTradeStats(); renderTradesTable(); }
function checkTradeOutcome(currentPrice) { if (!activeTrade) return; const { action, entry, tp, sl } = activeTrade; let result = null; let exitPrice = null; if (action === 'BUY') { if (currentPrice >= tp) { result = 'WIN'; exitPrice = tp; } else if (currentPrice <= sl) { result = 'LOSS'; exitPrice = sl; } } else { if (currentPrice <= tp) { result = 'WIN'; exitPrice = tp; } else if (currentPrice >= sl) { result = 'LOSS'; exitPrice = sl; } } if (result) closeTrade(result, exitPrice); }
function closeTrade(result, exitPrice) { if (!activeTrade) return; let pnl_pct = 0; if (result === 'WIN') pnl_pct = stats.risk_pct * activeTrade.rr * 100; if (result === 'LOSS') pnl_pct = -stats.risk_pct * 100; if (result) { tradeHistory.unshift({ time: activeTrade.time, action: activeTrade.action, entry: activeTrade.entry, tp: activeTrade.tp, sl: activeTrade.sl, result, pnl_pct }); totalPnl += pnl_pct; if (tradeHistory.length > 50) tradeHistory.pop(); } activeTrade = null; setTpSlLines(null, null, null); saveSimState(); updateTradeStats(); renderTradesTable(); }

function updatePriceStats() { const el = document.getElementById('stat-price'); const hdrEl = document.getElementById('hdr-price'); const p = stats.price; if (!p) return; el.textContent = p.toLocaleString('en', {minimumFractionDigits: 2, maximumFractionDigits: 6}); hdrEl.textContent = p.toLocaleString('en', {minimumFractionDigits: 2, maximumFractionDigits: 6}); document.getElementById('stat-atr').textContent = stats.atr ? `ATR ${stats.atr.toFixed(4)}` : 'ATR --'; if (stats.prevPrice && stats.prevPrice !== p) { const up = p > stats.prevPrice; el.className = 'stat-value ' + (up ? 'up' : 'down'); hdrEl.className = 'live-price ' + (up ? 'up' : 'down'); } }
function updateOIStats() { const v = stats.oi; if (!v) return; const fmt = v >= 1e6 ? (v/1e6).toFixed(2) + 'M' : v >= 1e3 ? (v/1e3).toFixed(1) + 'K' : v.toFixed(0); document.getElementById('stat-oi').textContent = fmt; document.getElementById('stat-oi-time').textContent = stats.oiTime || '--'; }
function updateLSRStats() { if (!stats.lsr) return; document.getElementById('stat-lsr').textContent = stats.lsr.toFixed(4); const b = document.getElementById('stat-bias'); b.textContent = stats.bias.split('_')[0]; b.className = 'bias-badge ' + stats.bias; }
function updateBalanceStats() { if (!stats.balance) return; document.getElementById('stat-balance').childNodes[0].nodeValue = stats.balance.toLocaleString('en', {maximumFractionDigits: 2}) + ' USDT '; document.getElementById('stat-risk').textContent = 'Risk ' + (stats.risk_pct * 100).toFixed(1) + '% / trade'; if (stats.initBalance && stats.balance !== stats.initBalance) { const diff = ((stats.balance - stats.initBalance) / stats.initBalance) * 100; const span = document.getElementById('stat-bal-pct'); span.textContent = `(${diff > 0 ? '+' : ''}${diff.toFixed(2)}%)`; span.style.color = diff > 0 ? 'var(--accent)' : 'var(--danger)'; } }
function updateTradeStats() { const wins = tradeHistory.filter(t => t.result === 'WIN').length; const total = tradeHistory.length; const wr = total ? (wins / total * 100).toFixed(1) : '--'; const pnlStr = totalPnl >= 0 ? '+' + totalPnl.toFixed(2) : totalPnl.toFixed(2); const wrEl = document.getElementById('stat-winrate'); const pnlEl = document.getElementById('stat-pnl'); wrEl.textContent = total ? wr + '%' : '--'; wrEl.className = 'stat-value ' + (total ? (wins/total >= 0.5 ? 'up' : 'down') : ''); pnlEl.textContent = total ? pnlStr + '%' : '+0.00%'; pnlEl.className = 'stat-value ' + (totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''); document.getElementById('stat-trades').textContent = total + ' closed' + (activeTrade ? ' · 1 open' : ''); document.getElementById('stat-pnl-sub').textContent = signalCount + ' signals fired'; }

function _loadScript(src) { return new Promise((res, rej) => { if (document.querySelector(`script[src="${src}"]`)) { res(); return; } const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }

// FIX CHART GEPENG: ResizeObserver KOKOH
async function initChart() { 
  if (_lwChart) return; 
  const _LC_CDNS = [ 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js', 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js' ]; 
  let loaded = false; 
  for (const src of _LC_CDNS) { 
    try { await _loadScript(src); if (typeof LightweightCharts !== 'undefined') { loaded = true; break; } } catch(e) {} 
  } 
  if (!loaded) { document.getElementById('chart-status').textContent = '✗ lib load failed'; return; } 
  
  const container = document.getElementById('chart-container'); 
  if (!container) return; 
  const emptyEl = document.getElementById('chart-empty'); 
  if (emptyEl) emptyEl.style.display = 'none'; 
  
  _lwChart = LightweightCharts.createChart(container, { 
    width: container.clientWidth || 600, 
    height: container.clientHeight || 320, 
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
    if(entries.length === 0 || entries[0].target !== container) return;
    const newRect = entries[0].contentRect;
    if (_lwChart && newRect.width > 0 && newRect.height > 0 && !isChartHidden) { 
      _lwChart.applyOptions({ width: newRect.width, height: newRect.height }); 
    } 
  }); 
  ro.observe(container); 
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
function renderCandles(candles) { if (!_candleSeries || !candles?.length) return; _candleSeries.setData(candles); _volSeries.setData(candles.map(c => ({ time: c.time, value: c.volume, color: c.close >= c.open ? '#26a69a30' : '#ef535030' }))); _resetLiveCandle && _resetLiveCandle(); _lastCandleTs = candles[candles.length - 1]?.time || _lastCandleTs; _applyMarkers(); _lwChart.timeScale().scrollToRealTime(); }
let _liveCandle = null;
function updateLiveCandle(price) { if (!_candleSeries || !_lastCandleTs) return; const tf = parseInt(_currentTf) || 5; const tfSec = tf * 60; const now = Math.floor(Date.now() / 1000); const candleTs = Math.floor(now / tfSec) * tfSec; try { if (!_liveCandle || candleTs > _liveCandle.ts) { _liveCandle = { ts: candleTs, open: price, high: price, low: price, close: price }; _candleSeries.update({ time: candleTs, open: price, high: price, low: price, close: price }); _volSeries.update({ time: candleTs, value: 0, color: '#3b82f620' }); _lastCandleTs = candleTs; } else { _liveCandle.close = price; if (price > _liveCandle.high) _liveCandle.high = price; if (price < _liveCandle.low) _liveCandle.low = price; _candleSeries.update({ time: _liveCandle.ts, open: _liveCandle.open, high: _liveCandle.high, low: _liveCandle.low, close: _liveCandle.close }); } } catch(e) {} }
function _resetLiveCandle() { _liveCandle = null; }
let _pendingMarkers = [];
function addSignalMarker(action, price) { if (!_lastCandleTs) return; const tf = parseInt(_currentTf) || 5; const tfSec = tf * 60; const now = Math.floor(Date.now() / 1000); const ts = Math.floor(now / tfSec) * tfSec; _pendingMarkers.push({ time: ts, type: action }); if (_pendingMarkers.length > 50) _pendingMarkers.shift(); _applyMarkers(); priceHistory.push({ price, time: Date.now(), signal: action }); if (priceHistory.length > MAX_CHART_POINTS) priceHistory.shift(); }
function _applyMarkers() { if (!_candleSeries || !_pendingMarkers.length) return; const markers = _pendingMarkers.map(m => ({ time: m.time, position: m.type === 'BUY' ? 'belowBar' : 'aboveBar', color: m.type === 'BUY' ? '#00e5a0' : '#ef4444', shape: m.type === 'BUY' ? 'arrowUp' : 'arrowDown', text: m.type, size: 1.5 })); try { _candleSeries.setMarkers(markers); } catch(e) {} }

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

async function setTimeframe(btn) { document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); _currentTf = btn.dataset.tf; const cached = _ohlcvCache[_currentTf]; if (cached) { renderCandles(cached); } const fresh = await fetchOHLCV(_currentTf); if (fresh) renderCandles(fresh); }
function addPricePoint(price, signal, tp, sl) { priceHistory.push({ price, time: Date.now(), signal, tp, sl }); if (priceHistory.length > MAX_CHART_POINTS) priceHistory.shift(); updateLiveCandle(price); document.getElementById('chart-empty').style.display = 'none'; }
let _ohlcvRefreshTimer = null;
function _scheduleOHLCVRefresh() { if (_ohlcvRefreshTimer) clearInterval(_ohlcvRefreshTimer); const intervalMs = (parseInt(_currentTf) >= 60) ? 300_000 : 30_000; _ohlcvRefreshTimer = setInterval(async () => { const candles = await fetchOHLCV(_currentTf); if (candles) renderCandles(candles); }, intervalMs); }

async function startChart() { 
  await initChart(); 
  if (!_chartReady) return; 
  const candles = await fetchOHLCV(_currentTf); 
  if (candles) renderCandles(candles); 
  _scheduleOHLCVRefresh(); 
}
startChart();

function renderTradesTable() { const tbody = document.getElementById('trades-tbody'); if (!tradeHistory.length && !activeTrade) { tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text2);text-align:center;padding:10px">Belum ada trade</td></tr>'; return; } let rows = ''; if (activeTrade) { rows += `<tr><td>${activeTrade.time}</td><td class="trade-open">${activeTrade.action}</td><td>${activeTrade.entry.toFixed(4)}</td><td class="trade-win">${activeTrade.tp.toFixed(4)}</td><td class="trade-loss">${activeTrade.sl.toFixed(4)}</td><td class="trade-open">OPEN</td><td class="trade-open">--</td></tr>`; } tradeHistory.slice(0, 20).forEach(t => { const cls = t.result === 'WIN' ? 'trade-win' : 'trade-loss'; const pnl = (t.pnl_pct >= 0 ? '+' : '') + t.pnl_pct.toFixed(2) + '%'; rows += `<tr><td>${t.time}</td><td class="${cls}">${t.action}</td><td>${t.entry.toFixed(4)}</td><td>${t.tp.toFixed(4)}</td><td>${t.sl.toFixed(4)}</td><td class="${cls}">${t.result}</td><td class="${cls}">${pnl}</td></tr>`; }); tbody.innerHTML = rows; }

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
}

function setFilter(btn) { document.querySelectorAll('.fbtn').forEach(b => b.classList.remove('active')); btn.classList.add('active'); filterLevel = btn.dataset.lvl; renderLogs(); }
function toggleAutoScroll() { autoScroll = !autoScroll; const btn = document.getElementById('btn-autoscroll'); btn.style.borderColor = autoScroll ? 'var(--accent)' : ''; btn.style.color = autoScroll ? 'var(--accent)' : ''; }
async function clearLogs() { try { await fetch('/api/clear-logs', { method: 'POST' }); } catch(e) {} logs = []; lastCount = 0; renderLogs(); }
function renderLogs() { const container = document.getElementById('log-container'); const filtered = filterLevel === 'ALL' ? logs : logs.filter(l => l.level === filterLevel); if (!filtered.length) { container.innerHTML = '<div class="empty-state"><div class="empty-icon">◈</div><div>Tidak ada log untuk filter ini</div></div>'; return; } const frag = document.createDocumentFragment(); filtered.forEach(l => { const row = document.createElement('div'); row.className = 'log-entry ' + l.level; row.innerHTML = `<span class="log-ts">${l.ts}</span><span class="log-lvl">${l.level}</span><span class="log-name">${l.name}</span><span class="log-msg">${escHtml(l.msg)}</span>`; frag.appendChild(row); }); container.innerHTML = ''; container.appendChild(frag); if (autoScroll) container.scrollTop = container.scrollHeight; }
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function toast(msg, ok=true) { const el = document.getElementById('toast'); el.textContent = msg; el.className = 'toast show ' + (ok ? 'ok' : 'err'); setTimeout(() => { el.className = 'toast'; }, 3000); }

async function poll() { try { const r = await fetch('/api/logs?since=' + lastCount); const d = await r.json(); if (d.logs && d.logs.length) { d.logs.forEach(parseLog); logs = [...logs, ...d.logs].slice(-500); lastCount = d.total; renderLogs(); } updateStatus(d.running); } catch(e) {} }

function updateStatus(running) { 
  const dot = document.getElementById('status-dot'); 
  const txt = document.getElementById('status-text'); 
  const btnS = document.getElementById('btn-start'); 
  const btnP = document.getElementById('btn-stop'); 
  dot.className = 'dot ' + (running ? 'running' : 'stopped'); 
  txt.textContent = running ? 'RUNNING' : 'STOPPED'; 
  btnS.disabled = running; 
  btnP.disabled = !running; 
  document.querySelectorAll('#config-form input, #config-form select').forEach(el => { el.disabled = running; });
}

async function startBot() { try { const r = await fetch('/api/start', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(collectEnv()) }); const d = await r.json(); toast(d.message, d.ok); } catch(e) { toast('Koneksi gagal', false); } }
async function stopBot() { try { const r = await fetch('/api/stop', { method: 'POST' }); const d = await r.json(); toast(d.message, d.ok); } catch(e) { toast('Koneksi gagal', false); } }

const _KEY_SENTINEL = '__UNCHANGED__';
function saveToLocal() {
  const state = {
    SYMBOL: document.getElementById('cfg-symbol').value, EXCHANGE: document.getElementById('cfg-exchange').value, EXCHANGE_MODE: document.getElementById('cfg-mode').value, TRADING_STYLE: document.getElementById('cfg-style').value, TARGET_TYPE: document.getElementById('cfg-target-type').value, LEVERAGE: document.getElementById('cfg-leverage').value, RISK_PCT: document.getElementById('cfg-risk').value, USE_MOCK_OHLCV: document.getElementById('cfg-mock').checked, DRY_RUN: document.getElementById('cfg-dryrun').checked
  };
  localStorage.setItem('botUIState', JSON.stringify(state));
}

document.querySelectorAll('input, select').forEach(el => { el.addEventListener('change', () => { saveConfig(); }); });

function collectEnv() {
  function keyVal(id) { const v = document.getElementById(id).value; return (v && v !== _KEY_SENTINEL) ? v : ''; }
  return {
    SYMBOL: document.getElementById('cfg-symbol').value.trim(), LEVERAGE: document.getElementById('cfg-leverage').value, EXCHANGE: document.getElementById('cfg-exchange').value, EXCHANGE_MODE: document.getElementById('cfg-mode').value, TRADING_STYLE: document.getElementById('cfg-style').value, TARGET_TYPE: document.getElementById('cfg-target-type').value, RISK_PCT: (parseInt(document.getElementById('cfg-risk').value) / 100).toString(), USE_MOCK_OHLCV: document.getElementById('cfg-mock').checked ? '1' : '0', DRY_RUN: document.getElementById('cfg-dryrun').checked ? '1' : '0', BYBIT_DEMO_API_KEY: keyVal('key-bybit-demo-key'), BYBIT_DEMO_API_SECRET: keyVal('key-bybit-demo-secret'), BYBIT_REAL_API_KEY: keyVal('key-bybit-real-key'), BYBIT_REAL_API_SECRET: keyVal('key-bybit-real-secret'), MEXC_API_KEY: keyVal('key-mexc-key'), MEXC_API_SECRET: keyVal('key-mexc-secret'),
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
    let local = {}; try { local = JSON.parse(localStorage.getItem('botUIState')) || {}; } catch(err) {}

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

    function loadKey(id, val) { if (!val) return; const el = document.getElementById(id); el.value = val; el.placeholder = '••••••••' + val.slice(-4); el.addEventListener('focus', function() { if (el.value === val) el.value = ''; }, {once:true}); el.addEventListener('blur', function() { if (el.value === '') el.value = val; }); }
    loadKey('key-bybit-demo-key', e.BYBIT_DEMO_API_KEY); loadKey('key-bybit-demo-secret', e.BYBIT_DEMO_API_SECRET); loadKey('key-bybit-real-key', e.BYBIT_REAL_API_KEY); loadKey('key-bybit-real-secret', e.BYBIT_REAL_API_SECRET); loadKey('key-mexc-key', e.MEXC_API_KEY); loadKey('key-mexc-secret', e.MEXC_API_SECRET);
    
    updateLeverageLimits();
  } catch(e) {}
}

const _BYBIT_INSTRUMENTS_URL = 'https://api.bytick.com/v5/market/instruments-info';
async function loadBybitPairs(exchange) {
  const statusEl = document.getElementById('pairs-status'); const sel = document.getElementById('cfg-symbol');
  if (!statusEl || !sel) return;
  
  if (exchange && exchange !== 'bybit') { 
    statusEl.textContent = 'MEXC — manual input'; statusEl.style.color = 'var(--warn)'; 
    sel.innerHTML = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','PEPEUSDT','ELSAUSDT','WIFUSDT'].map(s => `<option value="${s}">${s}</option>`).join(''); 
    
    // FIX AI INSIGHT: Visual Sync Reset untuk MEXC
    sel.onchange = () => { 
      document.getElementById('hdr-symbol').textContent = sel.value; 
      const btn = document.querySelector('.tf-btn.active') || document.querySelector('.tf-btn[data-tf="5"]'); 
      setTimeframe(btn); 
      if (typeof connectLivePriceWS === 'function') connectLivePriceWS(); 
      updateLeverageLimits(); 
      saveConfig(); 

      // Reset Layar AI Langsung!
      document.getElementById('ai-trend').textContent = "SINKRONISASI...";
      document.getElementById('ai-whale').textContent = "SINKRONISASI...";
      document.getElementById('ai-signal').textContent = "WAIT";
      document.getElementById('ai-advice').textContent = `Mereset memori AI dan mengambil data live koin ${sel.value}...`;
      document.getElementById('ai-entry').textContent = "0.00";
      document.getElementById('ai-tp').textContent = "0.00";
      document.getElementById('ai-sl').textContent = "0.00";

      // Reset Chart Data Cache
      _ohlcvCache = {};
      if (_candleSeries) _candleSeries.setData([]);
      if (_volSeries) _volSeries.setData([]);
      stats.price = null;
      stats.prevPrice = null;
      document.getElementById('hdr-price').textContent = "--";
      document.getElementById('stat-price').textContent = "--";
    };
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
    if (pending && pairs.includes(pending)) { sel.value = pending; document.getElementById('hdr-symbol').textContent = pending; } else if (!pending && pairs.includes('BTCUSDT')) { sel.value = 'BTCUSDT'; }
    delete sel.dataset.pendingSymbol; statusEl.textContent = `✓ ${pairs.length} pairs`; statusEl.style.color = 'var(--accent)';
    document.getElementById('hdr-symbol').textContent = sel.value;
    
    // FIX AI INSIGHT: Visual Sync Reset untuk BYBIT
    sel.onchange = () => { 
      document.getElementById('hdr-symbol').textContent = sel.value; 
      const btn = document.querySelector('.tf-btn.active') || document.querySelector('.tf-btn[data-tf="5"]'); 
      setTimeframe(btn); 
      if (typeof connectLivePriceWS === 'function') connectLivePriceWS(); 
      updateLeverageLimits(); 
      saveConfig(); 

      // Reset Layar AI Langsung!
      document.getElementById('ai-trend').textContent = "SINKRONISASI...";
      document.getElementById('ai-whale').textContent = "SINKRONISASI...";
      document.getElementById('ai-signal').textContent = "WAIT";
      document.getElementById('ai-advice').textContent = `Mereset memori AI dan mengambil data live koin ${sel.value}...`;
      document.getElementById('ai-entry').textContent = "0.00";
      document.getElementById('ai-tp').textContent = "0.00";
      document.getElementById('ai-sl').textContent = "0.00";

      // Reset Chart Data Cache
      _ohlcvCache = {};
      if (_candleSeries) _candleSeries.setData([]);
      if (_volSeries) _volSeries.setData([]);
      stats.price = null;
      stats.prevPrice = null;
      document.getElementById('hdr-price').textContent = "--";
      document.getElementById('stat-price').textContent = "--";
    };
  } catch(err) { statusEl.textContent = '✗ fetch failed'; statusEl.style.color = 'var(--danger)'; }
}
function onExchangeChange(val) { loadBybitPairs(val); updateLeverageLimits(); saveConfig(); }

let _wsTicker = null;
function _getLiveSymbol() { const sel = document.getElementById('cfg-symbol'); return (sel && sel.value) ? sel.value.replace('_','') : 'BTCUSDT'; }

function connectLivePriceWS() {
  const sym = _getLiveSymbol(); if (_wsTicker) { _wsTicker.close(); _wsTicker = null; }
  _wsTicker = new WebSocket('wss://stream.bytick.com/v5/public/linear');
  _wsTicker.onopen = () => _wsTicker.send(JSON.stringify({"op": "subscribe", "args": [`tickers.${sym}`]}));
  _wsTicker.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data?.topic === `tickers.${sym}` && data?.data) {
      const ticker = data.data; 
      if (ticker.lastPrice !== undefined) {
          const price = parseFloat(ticker.lastPrice);
          if (price && !isNaN(price)) {
              stats.prevPrice = stats.price; stats.price = price; addPricePoint(price, null, null, null); 
              if (activeTrade) checkTradeOutcome(price); updatePriceStats();
          }
      }
      if (ticker.price24hPcnt !== undefined) {
          let pct24h = parseFloat(ticker.price24hPcnt);
          if (!isNaN(pct24h)) {
              if (Math.abs(pct24h) < 1.0) pct24h = pct24h * 100;
              const deltaEl = document.getElementById('hdr-delta');
              if (deltaEl) {
                const sign = pct24h >= 0 ? '+' : ''; deltaEl.textContent = `${sign}${pct24h.toFixed(2)}% 24h`;
                deltaEl.className = 'price-delta ' + (pct24h >= 0 ? 'up' : 'down'); deltaEl.style.display = '';
              }
          }
      }
    }
  };
  _wsTicker.onclose = () => setTimeout(connectLivePriceWS, 3000);
}

async function fetchAIInsight() {
  try {
    const r = await fetch('/api/insight'); const d = await r.json();
    document.getElementById('ai-trend').textContent = d.trend_state || "-";
    document.getElementById('ai-whale').textContent = d.whale_bias || "-";
    document.getElementById('ai-signal').textContent = d.signal_status || "-";
    document.getElementById('ai-advice').textContent = d.advice || "-";
    document.getElementById('ai-ts').textContent = d.timestamp || "-";
    
    document.getElementById('ai-entry').textContent = (d.entry_target || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 6});
    document.getElementById('ai-tp').textContent = (d.tp_target || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 6});
    document.getElementById('ai-sl').textContent = (d.sl_target || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 6});
    
    if (d.last_price && !stats.price) { stats.price = d.last_price; updatePriceStats(); }
    if (d.pct_24h !== undefined && d.pct_24h !== null) {
        const deltaEl = document.getElementById('hdr-delta'); const sign = d.pct_24h >= 0 ? '+' : '';
        deltaEl.textContent = `${sign}${d.pct_24h.toFixed(2)}% 24h`; deltaEl.className = 'price-delta ' + (d.pct_24h >= 0 ? 'up' : 'down'); deltaEl.style.display = '';
    }
    if (d.open_interest) { stats.oi = d.open_interest; stats.oiTime = d.timestamp; updateOIStats(); }
    if (d.lsr_val) { stats.lsr = d.lsr_val; let biasTxt = 'NEUTRAL'; if (d.lsr_val > 1.05) biasTxt = 'LONG_HEAVY'; else if (d.lsr_val < 0.95) biasTxt = 'SHORT_HEAVY'; stats.bias = biasTxt; updateLSRStats(); }
    if (d.balance > 0) {
        stats.balance = d.balance;
        if (!stats.initBalance) {
            const savedBal = localStorage.getItem('botInitBalance');
            if (savedBal) stats.initBalance = parseFloat(savedBal); else { stats.initBalance = d.balance; localStorage.setItem('botInitBalance', d.balance); }
        }
        updateBalanceStats();
    }
    const trendEl = document.getElementById('ai-trend');
    if(d.trend_state && d.trend_state.includes('TRAP')) trendEl.style.color = 'var(--danger)';
    else if(d.trend_state && d.trend_state.includes('BULLISH')) trendEl.style.color = 'var(--accent)';
    else if(d.trend_state && d.trend_state.includes('BEARISH')) trendEl.style.color = 'var(--warn)';
    else trendEl.style.color = 'var(--text)';
  } catch(e) {}
}

loadConfig(); loadSimState(); loadBybitPairs('bybit'); poll(); setInterval(poll, 1500); setInterval(fetchAIInsight, 3000); setTimeout(connectLivePriceWS, 1000);