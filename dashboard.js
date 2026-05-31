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

let _multiPairMode = false;
let _multiCharts = [];
let _chartRO = null;
let _multiROs = [];

function toggleMultiPairMode(mode) {
    _multiPairMode = (mode === 'multi');
    
    // Clean up old observers
    if (_chartRO) { _chartRO.disconnect(); _chartRO = null; }
    if (_multiROs.length) { _multiROs.forEach(ro => ro.disconnect()); _multiROs = []; }
    
    if (_multiPairMode) {
        document.getElementById('chart-wrapper').className = 'chart-wrap chart-grid';
        if (_lwChart) {
            _lwChart.remove();
            _lwChart = null;
        }
        _chartReady = false;
        renderGridCharts();
    } else {
        document.getElementById('chart-wrapper').className = 'chart-wrap';
        if (_multiCharts.length) {
            _multiCharts.forEach(c => c.chart.remove());
            _multiCharts = [];
        }
        _lwChart = null; // force re-init
        _chartReady = false;
        document.getElementById('chart-container').innerHTML = '';
        initChart();
    }
}

let _lastAIScanResults = [];
let _aiSignalHistory = [];
let _aiScanTF = '15';

let stats = {
  price: null, prevPrice: null, atr: null, oi: null, oiTime: null,
  lsr: null, bias: 'NEUTRAL', balance: null, initBalance: null, risk_pct: 0.03
};

let activeTrade = null;
let tradeHistory = [];
let signalCount = 0;
let totalPnl = 0;
let isChartHidden = false;
let _symbolAtBotStart = '';

// ── Safe Storage Wrapper ──────────────────────────────────────────────────────
const Storage = {
    get(key, defaultVal = null) {
        try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : defaultVal; }
        catch(e) { return defaultVal; }
    },
    set(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); return true; }
        catch(e) { console.warn('Storage unavailable:', e); return false; }
    },
    remove(key) { try { localStorage.removeItem(key); } catch(e) {} }
};

// ══════════════════════════════════════════════════════════════════════════════
// AI Signal History
// ══════════════════════════════════════════════════════════════════════════════

async function _loadAISignalHistory() { try { const res = await fetch('/api/ai_history'); if (res.ok) { _aiSignalHistory = await res.json(); renderAISignalHistory(); } } catch(e) {} }
function _saveAISignalHistory() { fetch('/api/ai_history', { method: 'POST', body: JSON.stringify(_aiSignalHistory.slice(0, 300)) }).catch(e=>console.error(e)); }

// [FIX-AI-3] Accept forcePrice so WS tick can call this directly
function _trackAISignalOutcomes(forcePrice) {
    const price = forcePrice || stats.price;
    if (!_aiSignalHistory.length || !price) return;
    let changed = false;
    _aiSignalHistory = _aiSignalHistory.map(sig => {
        if (sig.status === 'WIN' || sig.status === 'LOSS') return sig;
        
        // [FIX-AI-SIGNAL] Hanya update signal yang symbol-nya sesuai dengan harga saat ini
        const currentLiveSym = (typeof _getLiveSymbol === 'function') ? _getLiveSymbol() : '';
        if (sig.symbol !== currentLiveSym) return sig;

        const updated = { ...sig };
        const exchange = document.getElementById('cfg-exchange').value || 'mexc';
        const activeSym = document.getElementById('cfg-symbol').value || 'BTCUSDT';
        const userLev = stats.leverage || 10;
        const levRatio = userLev / getMaxLeverage(exchange, activeSym);
        const lev = Math.max(1, Math.round(getMaxLeverage(exchange, sig.symbol) * levRatio));

        if (updated.status === 'PENDING') {
            if ((sig.direction === 'LONG' || sig.direction === 'BUY') && price <= sig.entry) { updated.status = 'OPEN'; changed = true; }
            else if ((sig.direction === 'SHORT' || sig.direction === 'SELL') && price >= sig.entry) { updated.status = 'OPEN'; changed = true; }
        }

        if (updated.status === 'OPEN') {
            if (sig.direction === 'LONG' || sig.direction === 'BUY') {
                if (price >= sig.tp) { updated.status = 'WIN'; updated.pnl = '+' + (((sig.tp - sig.entry) / sig.entry) * 100 * lev).toFixed(2) + '%'; updated.closeTime = new Date().toLocaleTimeString(); changed = true; }
                else if (price <= sig.sl) { updated.status = 'LOSS'; updated.pnl = (((sig.sl - sig.entry) / sig.entry) * 100 * lev).toFixed(2) + '%'; updated.closeTime = new Date().toLocaleTimeString(); changed = true; }
            } else {
                if (price <= sig.tp) { updated.status = 'WIN'; updated.pnl = '+' + (((sig.entry - sig.tp) / sig.entry) * 100 * lev).toFixed(2) + '%'; updated.closeTime = new Date().toLocaleTimeString(); changed = true; }
                else if (price >= sig.sl) { updated.status = 'LOSS'; updated.pnl = (((sig.entry - sig.sl) / sig.entry) * 100 * lev).toFixed(2) + '%'; updated.closeTime = new Date().toLocaleTimeString(); changed = true; }
            }
        }
        
        if (updated.status === 'OPEN') {
            let unrealizedPct = 0;
            if (sig.direction === 'LONG' || sig.direction === 'BUY') {
                unrealizedPct = ((price - sig.entry) / sig.entry) * 100.0 * lev;
                const maxWin = ((sig.tp - sig.entry) / sig.entry) * 100.0 * lev;
                const maxLoss = ((sig.sl - sig.entry) / sig.entry) * 100.0 * lev;
                if (unrealizedPct > maxWin) unrealizedPct = maxWin;
                if (unrealizedPct < maxLoss) unrealizedPct = maxLoss;
            } else {
                unrealizedPct = ((sig.entry - price) / sig.entry) * 100.0 * lev;
                const maxWin = ((sig.entry - sig.tp) / sig.entry) * 100.0 * lev;
                const maxLoss = ((sig.entry - sig.sl) / sig.entry) * 100.0 * lev;
                if (unrealizedPct > maxWin) unrealizedPct = maxWin;
                if (unrealizedPct < maxLoss) unrealizedPct = maxLoss;
            }
            const sign = unrealizedPct >= 0 ? '+' : '';
            updated.pnl = `${sign}${unrealizedPct.toFixed(2)}%`;
            changed = true;
        }

        return updated;
    });
    if (changed) { _saveAISignalHistory(); renderAISignalHistory(); }
}

function renderAISignalHistory() {
    const el = document.getElementById('ai-signal-history-body');
    if (!el) return;
    const wins  = _aiSignalHistory.filter(s => s.status === 'WIN').length;
    const losses = _aiSignalHistory.filter(s => s.status === 'LOSS').length;
    const opens  = _aiSignalHistory.filter(s => s.status === 'OPEN').length;
    const total  = wins + losses;
    const wr     = total ? (wins / total * 100).toFixed(1) + '%' : '--';
    const sumEl = document.getElementById('ai-hist-summary');
    if (sumEl) {
        sumEl.innerHTML = `
            <span style="color:var(--text2)">Total: <strong style="color:var(--text)">${_aiSignalHistory.length}</strong></span>
            <span style="color:var(--accent)">WIN: <strong>${wins}</strong></span>
            <span style="color:var(--danger)">LOSS: <strong>${losses}</strong></span>
            <span style="color:var(--warn)">OPEN: <strong>${opens}</strong></span>
            <span style="color:var(--text2)">WinRate: <strong style="color:${total && wins/total >= 0.5 ? 'var(--accent)' : 'var(--danger)'}">${wr}</strong></span>
        `;
    }
    if (!_aiSignalHistory.length) {
        el.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text2);font-family:var(--mono);font-size:11px;">Scan pair untuk mulai auto-tracking signal</td></tr>`;
        return;
    }
    el.innerHTML = _aiSignalHistory.map(s => {
        const isWin = s.status === 'WIN', isLoss = s.status === 'LOSS', isOpen = s.status === 'OPEN';
        const dec = s.entry < 1 ? 6 : s.entry < 10 ? 4 : s.entry < 1000 ? 3 : 2;
        const statusColor = isWin ? 'var(--accent)' : isLoss ? 'var(--danger)' : 'var(--warn)';
        const statusBg = isWin ? 'rgba(0,229,160,0.12)' : isLoss ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.12)';
        const dirColor = (s.direction === 'LONG' || s.direction === 'BUY') ? 'var(--accent)' : 'var(--danger)';

        let livePriceHTML = '<span style="color:var(--text2)">--</span>';
        let distInfo = '';
        if (isOpen && s.livePrice) {
            const isProfit = (s.direction === 'LONG' || s.direction === 'BUY') ? s.livePrice > s.entry : s.livePrice < s.entry;
            const pColor = isProfit ? 'var(--accent)' : 'var(--danger)';
            livePriceHTML = `<span style="color:${pColor};font-family:var(--mono);font-weight:bold">${s.livePrice.toFixed(dec)}</span>`;
            
            const price = s.livePrice;
            if (s.direction === 'LONG' || s.direction === 'BUY') {
                const pctToTp = ((s.tp - price) / price * 100).toFixed(2);
                const pctToSl = ((price - s.sl) / price * 100).toFixed(2);
                distInfo = `<span style="color:var(--text2);font-size:9px;">TP:${pctToTp}% SL:${pctToSl}%</span>`;
            } else {
                const pctToTp = ((price - s.tp) / price * 100).toFixed(2);
                const pctToSl = ((s.sl - price) / price * 100).toFixed(2);
                distInfo = `<span style="color:var(--text2);font-size:9px;">TP:${pctToTp}% SL:${pctToSl}%</span>`;
            }
        }

        return `<tr onmouseenter="this.style.background='rgba(255,255,255,0.02)'" onmouseleave="this.style.background=''">
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:var(--text2);font-size:11px;">${s.time}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);font-weight:700;color:var(--text);font-size:11px;cursor:pointer;" onclick="selectAISignalPair('${s.symbol}')">${s.symbol.replace('USDT','/USDT')}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:${dirColor};font-weight:700;font-size:11px;">${s.direction}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:var(--blue);font-size:11px;">${s.entry.toFixed(dec)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);">${livePriceHTML}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:var(--accent);font-size:11px;">${s.tp.toFixed(dec)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:var(--danger);font-size:11px;">${s.sl.toFixed(dec)}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);">
                <span style="background:${statusBg};color:${statusColor};padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;">${s.status}</span>
            </td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:${(s.pnl && s.pnl.includes('+')) || isWin ? 'var(--accent)' : (s.pnl && s.pnl.includes('-')) || isLoss ? 'var(--danger)' : 'var(--text2)'};font-weight:${isOpen ? '600' : '700'};font-size:11px;">${s.pnl || (isOpen ? distInfo : '--')}</td>
            <td style="padding:8px 12px;border-bottom:1px solid var(--border);">
                ${isOpen ? `<button onclick="forceAIExecutionPair('${s.symbol}')" style="background:var(--accent); color:#000; border:none; padding:4px 8px; font-weight:bold; border-radius:4px; font-size:9px; cursor:pointer">⚡ EXEC</button>` : ''}
            </td>
        </tr>`;
    }).join('');
}

function clearAISignalHistory() {
    if (confirm('Reset semua history AI Signal?')) { _aiSignalHistory = []; _saveAISignalHistory(); renderAISignalHistory(); }
}

// [FIX-AI-1] Auto-add ALL scan results to history without requiring click
function _autoAddSignalsToHistory(results) {
    if (!results || !results.length) return;
    let added = 0;
    const now = new Date().toLocaleTimeString();
    results.forEach(sig => {
        // Dedup: skip if already OPEN for this symbol
        const exists = _aiSignalHistory.some(h => h.symbol === sig.symbol && h.status === 'OPEN');
        if (exists) return;
        _aiSignalHistory.unshift({
            time: now,
            symbol: sig.symbol,
            direction: sig.direction,
            entry: sig.entry,
            tp: sig.tp,
            sl: sig.sl,
            rr: sig.rr,
            conf: sig.confidence,
            status: 'PENDING',
            pnl: null,
            closeTime: null
        });
        added++;
    });
    if (added > 0) {
        if (_aiSignalHistory.length > 300) _aiSignalHistory = _aiSignalHistory.slice(0, 300);
        _saveAISignalHistory();
        renderAISignalHistory();
        console.log('[AI] Auto-tracked', added, 'new signals to history');
    }
}

// ── Chart Utils ───────────────────────────────────────────────────────────────

function toggleChart() {
    isChartHidden = !isChartHidden;
    const wrap = document.getElementById('chart-wrapper');
    const toolbar = document.getElementById('chart-toolbar');
    const legend = document.getElementById('chart-legend');
    const btn = document.getElementById('btn-toggle-chart');
    if (wrap) wrap.style.display = isChartHidden ? 'none' : 'block';
    if (toolbar) toolbar.style.display = isChartHidden ? 'none' : 'flex';
    if (legend) legend.style.display = (!isChartHidden && _pendingMarkers.length > 0) ? 'flex' : 'none';
    if (btn) btn.textContent = isChartHidden ? '👁 Show Chart' : '👁 Hide Chart';
    if (!isChartHidden && _lwChart) {
        setTimeout(() => {
            const c = document.getElementById('chart-container');
            if (c && c.clientWidth > 10) { try { _lwChart.resize(c.clientWidth, c.clientHeight); } catch(e) {} }
        }, 50);
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

function getMaxLeverage(exchange, symbol) {
    if (exchange === 'mexc') {
        if (symbol.includes('BTC') || symbol.includes('ETH')) return 200;
        if (['SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','ADAUSDT'].includes(symbol)) return 100;
        return 50;
    } else {
        return (symbol.includes('BTC') || symbol.includes('ETH')) ? 100 : 50;
    }
}

function updateLeverageLimits() {
    const exchange = document.getElementById('cfg-exchange').value;
    const symbol   = document.getElementById('cfg-symbol').value || 'BTCUSDT';
    const num      = document.getElementById('cfg-leverage');
    const slide    = document.getElementById('cfg-lev-slider');
    
    let maxLev = getMaxLeverage(exchange, symbol);
    
    num.max = maxLev; slide.max = maxLev;
    num.setAttribute('max', maxLev); slide.setAttribute('max', maxLev);
    
    let currVal = parseInt(num.value) || 10;
    if (currVal > maxLev) currVal = maxLev;
    
    num.value = currVal; slide.value = currVal;
    document.getElementById('lev-val-display').textContent = currVal + 'x';
    saveToLocal();
    const levDisp = document.getElementById('lev-val-display');
    if (levDisp) levDisp.title = `Max ${symbol} on ${exchange}: ${maxLev}x`;
}

function limitLeverageInput(el) {
    const max = parseInt(el.max) || 100;
    if (parseInt(el.value) > max) {
        el.value = max;
        document.getElementById('cfg-lev-slider').value = max;
        document.getElementById('lev-val-display').textContent = max + 'x';
    }
    saveToLocal();
}

function _getSimHistKey() {
    const sel = document.getElementById('cfg-style');
    return 'botSimHist_' + (sel ? sel.value : 'scalping');
}

function saveSimState() { 
    Storage.set(_getSimHistKey(), { tradeHistory, totalPnl, signalCount, activeTrade }); 
}

function loadSimState() {
    try {
        const d = Storage.get(_getSimHistKey());
        if (d) { tradeHistory = d.tradeHistory || []; totalPnl = d.totalPnl || 0; signalCount = d.signalCount || 0; activeTrade = d.activeTrade || null; updateTradeStats(); renderTradesTable(); renderFullTradesTable(); }
        else { tradeHistory = []; totalPnl = 0; signalCount = 0; activeTrade = null; updateTradeStats(); renderTradesTable(); renderFullTradesTable(); }
        const savedBal = Storage.get('botInitBalance');
        if (savedBal) stats.initBalance = parseFloat(savedBal);
    } catch(e) { console.error('SimState Load Error', e); }
}

function resetHistory() {
    if (confirm("Reset semua histori P&L dan Win Rate di browser?")) {
        tradeHistory = []; totalPnl = 0; signalCount = 0; activeTrade = null; stats.initBalance = null;
        Storage.remove('botInitBalance');
        saveSimState(); updateTradeStats(); updateBalanceStats(); renderTradesTable(); renderFullTradesTable();
    }
}

// ── PARSERS ───────────────────────────────────────────────────────────────────
const PARSERS = [
  { re: /\[main\]   Exchange connected \| exchange=\w+ mode=\w+ \| free_USDT=([\d.]+)/, fn(m) {
      const b = parseFloat(m[1]); stats.balance = b;
      if (!stats.initBalance) { stats.initBalance = b; Storage.set('botInitBalance', b); }
      updateBalanceStats();
  } },
  { re: /Harga Real-Time \w+: ([\d.]+)/, fn(m) {
      const price = parseFloat(m[1]); stats.prevPrice = stats.price; stats.price = price;
      addPricePoint(price, null, null, null);
      updatePriceStats();
  } },
  { re: /\[OI\]\s+\S+\s+oi=([\d.]+)/, fn(m) {
      const raw = parseFloat(m[1]);
      if (!isLikelyTimestamp(raw)) { stats.oi = raw; stats.oiTime = new Date().toLocaleTimeString(); updateOIStats(); }
  } },
  { re: /\[WHALE\]\s+\S+\s+LSR=([\d.]+)\s+bias=(\w+)/, fn(m) { stats.lsr = parseFloat(m[1]); stats.bias = m[2]; updateLSRStats(); } },
  { re: /\[Executor\] entry=([\d.]+)\s+SL=([\d.]+)\s+TP=([\d.]+)\s+RR=([\d.]+)\s+conf=([\d.]+)/, fn(m) {
      pendingTradeParams = { entry: parseFloat(m[1]), sl: parseFloat(m[2]), tp: parseFloat(m[3]), rr: parseFloat(m[4]), conf: parseFloat(m[5]) };
  } },
  { re: /\[Executor\]   (BUY|SELL)\s/, fn(m) { pendingAction = m[1]; } },
  // Removed StateDB regex handler to prevent duplicate Mock trades
  { re: /\[Paper\]\s+.* LIMIT Order placed:\s+(BUY|SELL)/, fn(m) {
      // Just log or handle if needed
  } },
  { re: /\[ConsensusEngine\] Hasil: (BUY|SELL)/, fn(m) {
  } },
  { re: /\[main\].*?Signal:\s+(BUY|SELL)\s+conf=([\d.]+)\s+entry=([\d.]+)\s+TP=([\d.]+)\s+SL=([\d.]+)\s+RR=([\d.]+)/, fn(m) {
      pendingAction = m[1];
      pendingTradeParams = { entry: parseFloat(m[3]), sl: parseFloat(m[5]), tp: parseFloat(m[4]), rr: parseFloat(m[6]), conf: parseFloat(m[2]) };
      activeTrade = {
          action: pendingAction, limitPrice: pendingTradeParams.entry, entry: null, tp: pendingTradeParams.tp, sl: pendingTradeParams.sl, rr: pendingTradeParams.rr, status: 'PENDING', time: Date.now()
      };
      saveSimState(); updateTradeStats(); renderTradesTable(); renderFullTradesTable();
      setTpSlLines(activeTrade.limitPrice, activeTrade.tp, activeTrade.sl);
  } }
];

let pendingTradeParams = null, pendingAction = null;

function parseLog(log) { for (const p of PARSERS) { const m = log.msg.match(p.re); if (m) { p.fn(m, log); break; } } }

function isLikelyTimestamp(v) {
    if (!v || isNaN(v)) return false;
    if (v >= 1.58e12 && v <= 2.05e12) return true;
    if (v >= 1.58e9  && v <= 2.05e9)  return true;
    if (v > 1e11) return true;
    return false;
}

function openDryTrade(action, params) {
    if (activeTrade) closeTrade(null, null);
    activeTrade = { action, ...params, time: new Date().toLocaleTimeString(), status: 'OPEN' };
    addSignalMarker(action, params.entry); setTpSlLines(params.entry, params.tp, params.sl);
    saveSimState(); updateTradeStats(); renderTradesTable(); renderFullTradesTable();
}

function checkTradeOutcome(currentPrice) {
    if (!activeTrade) return;

    if (activeTrade.status === 'PENDING') {
        if ((activeTrade.action === 'BUY' && currentPrice <= activeTrade.limitPrice) ||
            (activeTrade.action === 'SELL' && currentPrice >= activeTrade.limitPrice)) {
            activeTrade.status = 'OPEN';
            activeTrade.entry = activeTrade.limitPrice;
            setTpSlLines(activeTrade.entry, activeTrade.tp, activeTrade.sl);
            saveSimState(); updateTradeStats(); renderTradesTable();
        } else if (Date.now() - activeTrade.time > 1800000) { // 30 mins timeout
            closeTrade('TIMEOUT', null);
        }
        return;
    }

    const { action, entry, tp, sl } = activeTrade;
    let result = null, exitPrice = null;
    if (action === 'BUY') { if (currentPrice >= tp) { result = 'WIN'; exitPrice = tp; } else if (currentPrice <= sl) { result = 'LOSS'; exitPrice = sl; } }
    else { if (currentPrice <= tp) { result = 'WIN'; exitPrice = tp; } else if (currentPrice >= sl) { result = 'LOSS'; exitPrice = sl; } }
    if (result) closeTrade(result, exitPrice);
}

function closeTrade(result, exitPrice) {
    if (!activeTrade) return;
    let pnl_pct = 0;
    if (result === 'WIN')  pnl_pct =  stats.risk_pct * activeTrade.rr * 100;
    if (result === 'LOSS') pnl_pct = -stats.risk_pct * 100;
    if (result && result !== 'TIMEOUT') {
        tradeHistory.unshift({ time: activeTrade.time, action: activeTrade.action, entry: activeTrade.entry, tp: activeTrade.tp, sl: activeTrade.sl, result, pnl_pct });
        totalPnl += pnl_pct;
        if (tradeHistory.length > 50) tradeHistory.pop();
    }
    activeTrade = null; setTpSlLines(null, null, null);
    saveSimState(); updateTradeStats(); renderTradesTable(); renderFullTradesTable();
}

function updatePriceStats() {
    const el = document.getElementById('stat-price'), hdrEl = document.getElementById('hdr-price');
    const p = stats.price; if (!p) return;
    const fmt = p.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
    if (el) el.textContent = fmt;
    if (hdrEl) hdrEl.textContent = fmt;
    const atrEl = document.getElementById('stat-atr');
    if (atrEl) atrEl.textContent = stats.atr ? `ATR ${stats.atr.toFixed(4)}` : 'ATR --';
    if (stats.prevPrice && stats.prevPrice !== p) {
        const up = p > stats.prevPrice;
        if (el) el.className = 'stat-value ' + (up ? 'up' : 'down');
        if (hdrEl) hdrEl.className = 'live-price ' + (up ? 'up' : 'down');
    }
    _trackAISignalOutcomes(); // track from bot poll price
}

function updateOIStats() {
    const v = stats.oi, oiEl = document.getElementById('stat-oi'), oiTimeEl = document.getElementById('stat-oi-time');
    if (!oiEl) return;
    if (!v || isNaN(v) || isLikelyTimestamp(v)) { oiEl.textContent = '—'; if (oiTimeEl) oiTimeEl.textContent = isLikelyTimestamp(v) ? 'data err' : '--'; return; }
    let fmt;
    if (v >= 1e9) fmt = (v/1e9).toFixed(2)+'B'; else if (v >= 1e6) fmt = (v/1e6).toFixed(2)+'M'; else if (v >= 1e3) fmt = (v/1e3).toFixed(1)+'K'; else fmt = v.toFixed(0);
    oiEl.textContent = fmt; if (oiTimeEl) oiTimeEl.textContent = stats.oiTime || '--';
}

function updateLSRStats() {
    if (!stats.lsr) return;
    const lsrEl = document.getElementById('stat-lsr'), biasEl = document.getElementById('stat-bias');
    if (lsrEl) lsrEl.textContent = stats.lsr.toFixed(4);
    if (biasEl) { biasEl.textContent = stats.bias.split('_')[0]; biasEl.className = 'bias-badge ' + stats.bias; }
}

function updateBalanceStats() {
    if (stats.balance === undefined) return;
    const balTextEl = document.getElementById('stat-bal-text');
    const riskEl = document.getElementById('stat-risk');
    if (balTextEl) balTextEl.textContent = stats.balance.toLocaleString('en', { maximumFractionDigits: 2 }) + ' USDT ';
    if (riskEl) riskEl.textContent = 'Risk ' + (stats.risk_pct * 100).toFixed(1) + '% / trade';
    if (stats.initBalance && stats.balance !== stats.initBalance && stats.initBalance > 0 && stats.balance > 0) {
        const diff = ((stats.balance - stats.initBalance) / stats.initBalance) * 100;
        const span = document.getElementById('stat-bal-pct');
        if (span) { span.textContent = `(${diff > 0 ? '+' : ''}${diff.toFixed(2)}%)`; span.style.color = diff > 0 ? 'var(--accent)' : 'var(--danger)'; }
    } else {
        const span = document.getElementById('stat-bal-pct');
        if (span) { span.textContent = '(0.00%)'; span.style.color = 'var(--text2)'; }
    }
    const isDry = document.getElementById('cfg-dryrun')?.checked;
    if (riskEl && isDry) {
        riskEl.innerHTML = '<span style="background:rgba(245,158,11,0.15);color:var(--warn);border:1px solid rgba(245,158,11,0.3);border-radius:3px;padding:1px 6px;font-size:9px;font-weight:700;margin-right:4px;">DRY RUN</span>Risk ' + (stats.risk_pct * 100).toFixed(1) + '% / trade';
    }
}

function updateTradeStats() {
    let srcHistory = _goTradeHistory || [];
    const wins = srcHistory.filter(t => t.status === 'CLOSED_TP' || (t.pnl || 0) > 0).length;
    const total = srcHistory.length;
    const wr = total ? (wins / total * 100).toFixed(1) : '--';
    let pnlSum = 0; srcHistory.forEach(t => pnlSum += (t.pnl || 0));
    const pnlStr = pnlSum >= 0 ? '+' + pnlSum.toFixed(2) : pnlSum.toFixed(2);
    const wrEl = document.getElementById('stat-winrate'), pnlEl = document.getElementById('stat-pnl');
    if (wrEl) { wrEl.textContent = total ? wr + '%' : '--'; wrEl.className = 'stat-value ' + (total ? (wins/total >= 0.5 ? 'up' : 'down') : ''); }
    if (pnlEl) { pnlEl.textContent = total ? pnlStr + '%' : '+0.00%'; pnlEl.className = 'stat-value ' + (pnlSum > 0 ? 'up' : pnlSum < 0 ? 'down' : ''); }
    const tradesEl = document.getElementById('stat-trades'), pnlSubEl = document.getElementById('stat-pnl-sub');
    if (tradesEl) tradesEl.textContent = total + ' closed' + (_goActiveTrades && _goActiveTrades.length > 0 ? '  ' + _goActiveTrades.length + ' open' : '');
    // signalCount is still tracked from ws ticker logs
    if (pnlSubEl) pnlSubEl.textContent = signalCount + ' signals fired';
}

// ── Chart Init ────────────────────────────────────────────────────────────────
function _loadScript(src) {
    return new Promise((res, rej) => {
        if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
        const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
    });
}

async function initChart() {
    if (_lwChart) return;
    const _LC_CDNS = ['/lw-charts.js','https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js','https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js'];
    let loaded = false;
    for (const src of _LC_CDNS) { try { await _loadScript(src); if (typeof LightweightCharts !== 'undefined') { loaded = true; break; } } catch(e) {} }
    if (!loaded) { const el = document.getElementById('chart-status'); if (el) el.textContent = '⚠ lib load failed'; return; }
    const wrapper = document.getElementById('chart-wrapper'), container = document.getElementById('chart-container');
    if (!container || !wrapper) return;
    const emptyEl = document.getElementById('chart-empty'); if (emptyEl) emptyEl.style.display = 'none';
    _lwChart = LightweightCharts.createChart(container, {
        autoSize: true, layout: { background: { type: 'solid', color: '#0d1117' }, textColor: '#8b949e' },
        grid: { vertLines: { color: '#1a2030' }, horzLines: { color: '#1a2030' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#30363d' },
        timeScale: { borderColor: '#30363d', timeVisible: true, secondsVisible: false },
        handleScroll: { mouseWheel: true, pressedMouseMove: true },
        handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true }
    });
    _candleSeries = _lwChart.addCandlestickSeries({ upColor: '#0ecb81', downColor: '#f6465d', borderUpColor: '#0ecb81', borderDownColor: '#f6465d', wickUpColor: '#0ecb81', wickDownColor: '#f6465d' });
    _volSeries = _lwChart.addHistogramSeries({ color: '#3b82f620', priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    _emaSeries = _lwChart.addLineSeries({ color: '#fcd535', lineWidth: 1, crosshairMarkerVisible: false });
    _rsiSeries = _lwChart.addLineSeries({ color: '#c084fc', lineWidth: 1, priceScaleId: 'rsi' });
    _lwChart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });
    _lwChart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    _chartRO = new ResizeObserver(entries => {
        if (entries.length === 0 || entries[0].target !== wrapper) return;
        const newRect = entries[0].contentRect;
        if (_lwChart && newRect.width > 10 && newRect.height > 10 && !isChartHidden) { try { _lwChart.resize(newRect.width, newRect.height); } catch(e) {} }
    });
    _chartRO.observe(wrapper);
    _chartReady = true;
}

async function renderGridCharts() {
    const container = document.getElementById('chart-container');
    if (!container) return;
    container.innerHTML = '';
    _multiCharts = [];
    
    // Instead of lightweight charts, we render a Data Grid Dashboard
    container.style.display = 'grid';
    container.style.gridTemplateColumns = 'repeat(auto-fit, minmax(200px, 1fr))';
    container.style.gap = '15px';
    container.style.padding = '20px';
    container.style.overflowY = 'auto';
    container.style.alignContent = 'start';
    
    // Get unique active symbols from AI History or defaults
    let pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT'];
    if (_aiSignalHistory && _aiSignalHistory.length > 0) {
        const uniquePairs = [...new Set(_aiSignalHistory.map(s => s.symbol))];
        if (uniquePairs.length > 0) {
            pairs = uniquePairs;
        }
    }

    for (let i = 0; i < pairs.length; i++) {
        const sym = pairs[i];
        const card = document.createElement('div');
        card.className = 'card';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '8px';
        card.style.padding = '15px';
        card.style.background = 'rgba(20, 24, 34, 0.6)';
        card.style.border = '1px solid var(--border)';
        
        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <strong style="color:var(--accent); font-size:16px;">${sym}</strong>
                <span class="live-price-${sym}" style="font-family:var(--mono); font-size:14px; font-weight:bold;">Loading...</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px;">
                <span style="color:var(--text2);">24h Volatility</span>
                <span class="live-vol-${sym}" style="color:#fff;">--</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px;">
                <span style="color:var(--text2);">Signal</span>
                <span class="live-signal-${sym}" style="color:var(--text2);">WAIT</span>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; margin-top:8px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.05);">
                <span style="color:var(--text2);">Active PNL</span>
                <span class="live-pnl-${sym}" style="font-family:var(--mono); font-weight:bold;">0.00%</span>
            </div>
        `;
        container.appendChild(card);
    }
    
    // Background updater for the grid
    if (window._multiGridUpdater) clearInterval(window._multiGridUpdater);
    window._multiGridUpdater = setInterval(async () => {
        if (!_multiPairMode) {
            clearInterval(window._multiGridUpdater);
            return;
        }
        try {
            const url = `/api/proxy/tickers?symbol=${pairs.join(',')}`;
            const r = await fetch(url);
            const d = await r.json();
            if (d && d.result && d.result.list) {
                d.result.list.forEach(tick => {
                    const pEl = container.querySelector(`.live-price-${tick.symbol}`);
                    if (pEl) {
                        const oldP = parseFloat(pEl.dataset.price || 0);
                        const newP = parseFloat(tick.lastPrice);
                        pEl.textContent = newP.toFixed(4);
                        pEl.dataset.price = newP;
                        if (newP > oldP) pEl.style.color = 'var(--green)';
                        else if (newP < oldP) pEl.style.color = 'var(--red)';
                    }
                    
                    const vEl = container.querySelector(`.live-vol-${tick.symbol}`);
                    if (vEl) {
                        const pct = parseFloat(tick.price24hPcnt) * 100;
                        vEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                        vEl.style.color = pct >= 0 ? 'var(--green)' : 'var(--red)';
                    }
                });
            }
        } catch(e) {}
        
        // Update Signal and PNL from _aiSignalHistory
        pairs.forEach(sym => {
            const activeSig = _aiSignalHistory.slice().reverse().find(s => s.symbol === sym && (s.status === 'OPEN' || s.status === 'PENDING'));
            const sEl = container.querySelector(`.live-signal-${sym}`);
            const pEl = container.querySelector(`.live-pnl-${sym}`);
            if (activeSig) {
                if (sEl) {
                    sEl.textContent = activeSig.direction;
                    sEl.style.color = (activeSig.direction==='BUY'||activeSig.direction==='LONG') ? 'var(--green)' : 'var(--red)';
                }
                if (pEl) {
                    pEl.textContent = activeSig.pnl || '0.00%';
                    pEl.style.color = (activeSig.pnl && activeSig.pnl.startsWith('+')) ? 'var(--green)' : 'var(--red)';
                }
            } else {
                if (sEl) { sEl.textContent = 'WAIT'; sEl.style.color = 'var(--text2)'; }
                if (pEl) { pEl.textContent = '0.00%'; pEl.style.color = 'var(--text2)'; }
            }
        });
    }, 2000);
}


