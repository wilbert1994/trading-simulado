let selectedSide = 'LONG';
let balanceChart = null;
let balanceHistory = [];
let allPrices = {};
let userPositions = {};
let userPortfolio = {};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function fmt(n, d) {
  if (n == null) return '$0';
  const fixed = typeof d === 'number' ? n.toFixed(d) : n;
  const parts = parseFloat(fixed).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: d || 2,
  });
  return '$' + parts;
}

function fmtNum(n, d) {
  if (n == null) return '0';
  return parseFloat(n).toLocaleString('en-US', {
    minimumFractionDigits: d || 0,
    maximumFractionDigits: d || 6,
  });
}

function sendTradeRequest(requestData) {
  return db.ref('tradeRequests').push({
    ...requestData,
    status: 'pending',
    timestamp: Date.now(),
  });
}

// ===== Firebase Realtime Listeners =====
function initFirebaseListeners() {
  db.ref('prices').on('value', (snap) => {
    const prices = snap.val();
    if (prices) {
      allPrices = prices;
      renderTickers(prices);
      updateTradeEstimate();
      updateMarkPrices(prices);
    }
  });

  db.ref('portfolio').on('value', (snap) => {
    userPortfolio = snap.val();
    if (userPortfolio) {
      renderPortfolio(userPortfolio);
      updateBalanceChart(userPortfolio);
    }
  });

  db.ref('positions').on('value', (snap) => {
    userPositions = snap.val() || {};
    renderPositions(userPositions);
  });

  db.ref('trades').on('value', (snap) => {
    renderTradeHistory(snap.val() || {});
  });

  db.ref('.info/connected').on('value', (snap) => {
    const ok = snap.val() === true;
    $('#connectionStatus').className = 'status-indicator ' + (ok ? 'connected' : 'disconnected');
    $('#statusText').textContent = ok ? 'Conectado' : 'Desconectado';
    if (ok) {
      db.ref('config/symbols').once('value', (s) => {
        updateSymbolSelector(s.val() || ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000BONKUSDT', '1000FLOKIUSDT']);
      });
    }
  });

  db.ref('config').on('value', (snap) => {
    const cfg = snap.val();
    if (cfg && cfg.strategyActive) {
      $('#btnStartStrategy').disabled = true;
      $('#btnStopStrategy').disabled = false;
      $('#statusText').textContent = 'Estrategia: ' + cfg.strategyName + ' | ' +
        new Date(cfg.lastEvaluation).toLocaleTimeString();
    } else if (cfg && cfg.strategyActive === false) {
      $('#btnStartStrategy').disabled = false;
      $('#btnStopStrategy').disabled = true;
    }
  });

  db.ref('strategyLog').limitToLast(50).on('value', (snap) => {
    renderLog(snap.val());
  });

  db.ref('serverStatus').on('value', (snap) => {
    const status = snap.val();
    if (status && status.online) {
      const ago = Math.floor((Date.now() - (status.lastBeat || status.startedAt)) / 1000);
      if (ago < 30) {
        $('#statusText').textContent = 'Servidor Online | ' +
          new Date(status.startedAt).toLocaleTimeString();
      } else {
        $('#statusText').textContent = 'Servidor sin respuesta (' + ago + 's)';
      }
    }
  });
}

// ===== UI =====
function renderPortfolio(p) {
  $('#balance').textContent = fmt(p.balance, 2);
  $('#initialBalance').textContent = fmt(p.initialBalance, 2);
  const sign = p.totalPnl >= 0 ? '+' : '';
  $('#totalPnl').textContent = sign + fmt(Math.abs(p.totalPnl), 2);
  $('#totalPnlPercent').textContent = (p.totalPnl >= 0 ? '+' : '') + p.totalPnlPercent.toFixed(2) + '%';
  $('#totalPnlPercent').className = 'value small ' + (p.totalPnl >= 0 ? 'positive' : 'negative');

  let used = 0;
  Object.values(userPositions).forEach(pos => { if (pos.status === 'OPEN') used += pos.initialMargin; });
  $('#usedMargin').textContent = fmt(used, 2);
  $('#availableBalance').textContent = fmt(p.balance, 2);
}

function renderTickers(prices) {
  let html = '';
  const order = ['BTCUSDT', 'ETHUSDT', '1000PEPEUSDT', 'WIFUSDT', '1000BONKUSDT', '1000FLOKIUSDT'];
  const sorted = Object.entries(prices).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  for (const [s, d] of sorted) {
    const cls = d.change24h >= 0 ? 'positive' : 'negative';
    const sign = d.change24h >= 0 ? '+' : '';
    html += `<div class="ticker-row">
      <div class="ticker-symbol">${s}</div>
      <div class="ticker-price">${fmt(d.price, 6)}</div>
      <div class="ticker-change ${cls}">${sign}${d.change24h.toFixed(2)}%</div>
      <div class="ticker-spark">H:${fmtNum(d.high24h, 4)} L:${fmtNum(d.low24h, 4)}</div>
    </div>`;
  }
  $('#tickersContainer').innerHTML = html;
}

function renderPositions(positions) {
  const open = Object.values(positions).filter(p => p.status === 'OPEN');
  if (open.length === 0) {
    $('#positionsContainer').innerHTML = '<div class="empty-state">No hay posiciones abiertas</div>';
    $('#btnCloseAll').style.display = 'none';
    return;
  }
  $('#btnCloseAll').style.display = 'inline-block';
  let html = '';
  for (const p of open) {
    const pnlClass = p.unrealizedPnl >= 0 ? 'positive' : 'negative';
    const pnlSign = p.unrealizedPnl >= 0 ? '+' : '';
    const coinQty = fmtNum(p.quantity, p.symbol.startsWith('1000') ? 0 : 6);
    html += `<div class="position-card">
      <div class="position-header">
        <span class="position-symbol">${p.symbol}</span><span class="position-side positive">LONG ${p.leverage}x</span>
        <button class="btn btn-sm btn-danger" onclick="closeTrade('${p.id}')">Cerrar</button>
      </div>
      <div class="position-details">
        <div class="detail"><span class="label">Entrada</span><span>${fmt(p.entryPrice, 6)}</span></div>
        <div class="detail"><span class="label">Mark</span><span>${fmt(p.markPrice||p.entryPrice, 6)}</span></div>
        <div class="detail"><span class="label">Invertido</span><span>${fmt(p.initialMargin, 2)}</span></div>
        <div class="detail"><span class="label">Cantidad</span><span>${coinQty}</span></div>
        <div class="detail"><span class="label">P&L</span><span class="${pnlClass}">${pnlSign}${fmt(Math.abs(p.unrealizedPnl), 4)} (${pnlSign}${p.unrealizedPnlPercent.toFixed(2)}%)</span></div>
        <div class="detail"><span class="label">Liq.</span><span class="text-danger">${fmt(p.liquidationPrice, 6)}</span></div>
      </div>
    </div>`;
  }
  $('#positionsContainer').innerHTML = html;
}

function renderLog(entries) {
  if (!entries || Object.keys(entries).length === 0) {
    $('#logContainer').innerHTML = '<div class="empty-state">Sin actividad. Inicia la estrategia para ver el log.</div>';
    return;
  }
  const list = Object.values(entries).sort((a, b) => b.time - a.time).slice(0, 50);
  const container = $('#logContainer');
  container.innerHTML = list.map(e =>
    `<div class="log-entry log-${e.type || 'info'}">
      <span class="log-time">${e.timeStr || ''}</span>
      <span class="log-msg">${e.msg}</span>
    </div>`
  ).join('');
  container.scrollTop = 0;
}

function updateMarkPrices(prices) {
  const cards = $$('.position-card');
  Object.values(userPositions).filter(p => p.status === 'OPEN').forEach((pos, i) => {
    const d = prices[pos.symbol];
    if (d && cards[i]) {
      const el = cards[i].querySelector('.detail:nth-child(2) span:last-child');
      if (el) el.textContent = fmt(d.price, 6);
    }
  });
}

function renderTradeHistory(trades) {
  const list = Object.values(trades).sort((a, b) => b.closeTime - a.closeTime).slice(0, 50);
  if (list.length === 0) {
    $('#tradeHistoryBody').innerHTML = '<tr><td colspan="7" class="empty-state">Sin operaciones</td></tr>';
    return;
  }
  let html = '';
  for (const t of list) {
    const pc = t.pnl >= 0 ? 'positive' : 'negative';
    const ps = t.pnl >= 0 ? '+' : '';
    html += `<tr>
      <td><strong>${t.symbol}</strong></td><td class="positive">LONG</td>
      <td>${fmt(t.entryPrice, 6)}</td><td>${fmt(t.exitPrice, 6)}</td>
      <td>${fmt(t.initialMargin || 0, 2)}</td>
      <td class="${pc}">${ps}${fmt(Math.abs(t.pnl), 4)}</td>
      <td class="text-muted">${new Date(t.closeTime).toLocaleString()}</td>
    </tr>`;
  }
  $('#tradeHistoryBody').innerHTML = html;
}

function updateSymbolSelector(symbols) {
  const select = $('#tradeSymbol');
  select.innerHTML = symbols.map(s => `<option value="${s}">${s}</option>`).join('');
  const cs = $('#chartSymbol');
  cs.innerHTML = '<option value="portfolio">Portafolio</option>' + symbols.map(s => `<option value="${s}">${s}</option>`).join('');
}

// ===== Trade Actions =====
$('#tradeSymbol').addEventListener('change', () => updateTradeEstimate());
$('#tradeUsdt').addEventListener('input', updateTradeEstimate);
$('#tradeLeverage').addEventListener('input', updateTradeEstimate);

function updateTradeEstimate() {
  const price = allPrices[$('#tradeSymbol').value]?.price;
  const usdt = parseFloat($('#tradeUsdt').value) || 0;
  const lev = parseFloat($('#tradeLeverage').value) || 1;
  if (price && usdt > 0) {
    const qty = usdt / price;
    const margin = usdt / lev;
    const decimals = $('#tradeSymbol').value.startsWith('1000') ? 0 : 6;
    $('#estMargin').textContent = fmt(margin, 2) + ' (' + fmtNum(qty, decimals) + ' monedas)';
  } else {
    $('#estMargin').textContent = '--';
  }
}

function openTrade() {
  const symbol = $('#tradeSymbol').value;
  const usdtAmount = parseFloat($('#tradeUsdt').value);
  const leverage = parseFloat($('#tradeLeverage').value);

  if (!usdtAmount || usdtAmount <= 0) { alert('Ingresa un monto en USDT'); return; }
  sendTradeRequest({ type: 'OPEN_MARKET', symbol, side: 'LONG', usdtAmount, leverage });
}

function closeTrade(positionId) {
  sendTradeRequest({ type: 'CLOSE_POSITION', positionId });
}

function closeAllPositions() {
  sendTradeRequest({ type: 'CLOSE_ALL' });
}

function resetSimulator() {
  if (!confirm('¿Reiniciar simulador? Se borrarán posiciones e historial.')) return;
  sendTradeRequest({ type: 'RESET' });
}

function toggleStrategy(action) {
  if (action === 'start') {
    sendTradeRequest({ type: 'STRATEGY_START' });
    $('#btnStartStrategy').disabled = true;
    $('#btnStopStrategy').disabled = false;
  } else {
    sendTradeRequest({ type: 'STRATEGY_STOP' });
    $('#btnStartStrategy').disabled = false;
    $('#btnStopStrategy').disabled = true;
  }
}

// ===== Chart =====
function initChart() {
  const canvas = $('#balanceChart');
  if (!canvas || typeof Chart === 'undefined') return;
  balanceChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Balance', data: [],
        borderColor: '#00d4aa', backgroundColor: 'rgba(0,212,170,0.1)',
        fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { ticks: { callback: v => fmt(v, 0) } },
      },
    },
  });
}

function updateBalanceChart(portfolio) {
  if (!balanceChart) return;
  balanceHistory.push({ time: new Date().toLocaleTimeString(), balance: portfolio.balance });
  if (balanceHistory.length > 100) balanceHistory.shift();
  balanceChart.data.labels = balanceHistory.map(p => p.time);
  balanceChart.data.datasets[0].data = balanceHistory.map(p => p.balance);
  balanceChart.update('none');
}

function updateChart() {}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  initChart();
  initFirebaseListeners();
  setInterval(() => { if (balanceChart) balanceChart.update('none'); }, 3000);
});
