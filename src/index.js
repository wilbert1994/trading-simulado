const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const { initDB, refs, readRef, get, set, update, remove } = require('./firebase');
const { startPricePolling, stopPricePolling, getPrice, getAllPrices, getAllSymbols } = require('./binance');
const {
  openMarketOrder,
  closePosition,
  updateUnrealizedPnl,
  resetSimulator,
  getUserPositions,
  getBalance,
} = require('./simulator');
const { SimpleStrategy } = require('./strategies/simple');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

let strategy = null;
let strategyInterval = null;
let autoTradeEnabled = false;
let lastMinuteLog = 0;

function strategyLog(msg, type) {
  const entry = {
    msg,
    type: type || 'info',
    time: Date.now(),
    timeStr: new Date().toLocaleTimeString(),
  };
  console.log(`[Estrategia] ${msg}`);
  set(`strategyLog/${Date.now()}`, entry).catch(e => console.error('[StrategyLog]', e.message));
}

async function processTradeRequests() {
  try {
    const requests = await readRef(refs.tradeRequests);
    if (!requests) return;

    for (const [reqId, req] of Object.entries(requests)) {
      if (req.status !== 'pending') continue;

      try {
        await update(`tradeRequests/${reqId}`, { status: 'processing' });

        if (req.type === 'OPEN_MARKET') {
          const price = getPrice(req.symbol);
          if (!price || price <= 0) throw new Error(`No hay precio disponible para ${req.symbol}`);
          const usdtAmount = parseFloat(req.usdtAmount || 0);
          const quantity = usdtAmount > 0
            ? parseFloat((usdtAmount / price).toFixed(6))
            : parseFloat(req.quantity || 0);
          const position = await openMarketOrder({
            symbol: req.symbol,
            side: req.side,
            quantity,
            leverage: parseFloat(req.leverage) || 1,
          });
          await set(`tradeRequests/${reqId}`, {
            ...req, status: 'completed',
            result: { success: true, position },
            completedAt: Date.now(),
          });
        } else if (req.type === 'CLOSE_POSITION') {
          const trade = await closePosition(req.positionId);
          await set(`tradeRequests/${reqId}`, {
            ...req, status: 'completed',
            result: { success: true, trade },
            completedAt: Date.now(),
          });
        } else if (req.type === 'CLOSE_ALL') {
          const positions = await getUserPositions();
          const openList = Object.values(positions).filter(p => p.status === 'OPEN');
          const results = await Promise.allSettled(openList.map(p => closePosition(p.id)));
          const closedTrades = results.filter(r => r.status === 'fulfilled').map(r => r.value);
          const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
          await update(`tradeRequests/${reqId}`, {
            status: 'completed',
            result: { success: true, closedTrades, errors: errors.length > 0 ? errors : undefined },
            completedAt: Date.now(),
          });
        } else if (req.type === 'RESET') {
          await resetSimulator();
          await update(`tradeRequests/${reqId}`, {
            status: 'completed', result: { success: true }, completedAt: Date.now(),
          });
        } else if (req.type === 'STRATEGY_START') {
          if (!autoTradeEnabled) {
            strategy = new SimpleStrategy();
            autoTradeEnabled = true;
            strategyInterval = setInterval(runStrategy, 1000);
            strategyLog('Estrategia INICIADA - buscando dips de -0.03% cada 1s, solo LONG, $200/trade', 'start');
            console.log('[Estrategia] Estrategia INICIADA - evaluando cada 1s');
            runStrategy(); // primera evaluación inmediata
          }
          await set('config', {
            symbols: getAllSymbols(),
            strategyActive: true,
            strategyName: strategy ? strategy.name : null,
            lastEvaluation: Date.now(),
            updatedAt: Date.now(),
          });
          await update(`tradeRequests/${reqId}`, {
            status: 'completed',
            result: { success: true, strategy: strategy.name },
            completedAt: Date.now(),
          });
        } else if (req.type === 'STRATEGY_STOP') {
          autoTradeEnabled = false;
          if (strategyInterval) { clearInterval(strategyInterval); strategyInterval = null; }
          strategyLog('Estrategia DETENIDA', 'stop');
          await set('config', {
            symbols: getAllSymbols(),
            strategyActive: false,
            strategyName: strategy ? strategy.name : null,
            lastEvaluation: Date.now(),
            updatedAt: Date.now(),
          });
          await update(`tradeRequests/${reqId}`, {
            status: 'completed', result: { success: true }, completedAt: Date.now(),
          });
        }
      } catch (err) {
        await update(`tradeRequests/${reqId}`, {
          status: 'error', error: err.message, completedAt: Date.now(),
        });
      }
    }
  } catch (err) {
    console.error('[TradeRequests] Error:', err.message);
  }
}

async function runStrategy() {
  const prices = getAllPrices();
  const symbols = Object.keys(prices);

  if (symbols.length === 0) {
    strategyLog('⏳ Esperando datos de Binance...', 'warn');
    return;
  }

  // Only log scanning once per minute to avoid flood
  const nowMin = Math.floor(Date.now() / 60000);
  if (nowMin !== lastMinuteLog) {
    strategyLog(`Escaneando ${symbols.length} pares`, 'info');
  }

  let signals = 0;
  let minProgress = Infinity;

  for (const [symbol, data] of Object.entries(prices)) {
    const result = strategy.onPrice(symbol, data.price);
    if (result.progress && result.progress < minProgress) {
      minProgress = result.progress;
    }
    if (result.signal !== 'HOLD' && autoTradeEnabled) {
      signals++;
      try {
        const positions = await getUserPositions() || {};
        const hasOpen = Object.values(positions).some(
          p => p.symbol === symbol && p.status === 'OPEN'
        );
        if (hasOpen) {
          continue;
        }
        const side = 'LONG';
        const tradeAmount = 200;
        const quantity = result.price > 0 ? parseFloat((tradeAmount / result.price).toFixed(6)) : 0;
        if (quantity > 0) {
          await openMarketOrder({ symbol, side, quantity, leverage: 1 });
          const coinQty = quantity.toFixed(symbol.startsWith('1000') ? 0 : 4);
          strategyLog(`✅ LONG ${symbol}: ${coinQty} monedas @ $${result.price.toFixed(4)} | invertido $${tradeAmount}`, 'trade');
        }
      } catch (err) {
        console.error(`[Estrategia] ❌ Error en ${symbol}:`, err.message);
      }
    }
  }

  if (minProgress < 6 && nowMin !== lastMinuteLog) {
    strategyLog(`Acumulando datos... (${minProgress}/6)`, 'info');
  }

  if (signals === 0) {
    // Log resumido cada minuto
    if (lastMinuteLog !== nowMin) {
      const sample = symbols.slice(0, 3).map(s => `${s}:$${prices[s]?.price?.toFixed(4) || '?'}`).join(' ');
      strategyLog(`Sin señales. ${sample}`, 'info');
      lastMinuteLog = nowMin;
    }
  }

  await set('config', {
    symbols: getAllSymbols(),
    strategyActive: autoTradeEnabled,
    strategyName: strategy ? strategy.name : null,
    lastEvaluation: Date.now(),
    updatedAt: Date.now(),
  });

  // Limpiar logs viejos (mantener últimos 100)
  const runCount = (runStrategy._count = (runStrategy._count || 0) + 1);
  if (runCount % 30 === 0) {
    try {
      const logs = await get('strategyLog');
      if (logs) {
        const keys = Object.keys(logs).sort((a, b) => Number(a) - Number(b));
        if (keys.length > 100) {
          for (const k of keys.slice(0, keys.length - 100)) {
              remove(`strategyLog/${k}`).catch(e => console.error('[LogCleanup]', e.message));
          }
        }
      }
    } catch {}
  }
}

// Force price fetch for debugging (exports fetchPrices for this)
app.get('/api/debug/fetch-prices', async (req, res) => {
  try {
    const { fetchPrices, getAllPrices } = require('./binance');
    await fetchPrices();
    const prices = getAllPrices();
    const valid = Object.entries(prices).filter(([,v]) => v && v.price).length;
    res.json({ valid: `${valid}/${Object.keys(prices).length}`, prices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), symbols: getAllSymbols() });
});

app.get('/api/portfolio', async (req, res) => {
  try {
    const portfolio = await readRef(refs.portfolio);
    const positions = await readRef(refs.positions) || {};
    const openPositions = Object.values(positions).filter(p => p.status === 'OPEN');
    res.json({ portfolio, positions: openPositions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/prices', (req, res) => {
  res.json({ prices: getAllPrices(), timestamp: Date.now() });
});

app.get('/api/positions', async (req, res) => {
  try {
    const positions = await readRef(refs.positions) || {};
    res.json({ positions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/trades', async (req, res) => {
  try {
    const trades = await readRef(refs.trades) || {};
    const list = Object.values(trades).sort((a, b) => b.closeTime - a.closeTime);
    res.json({ trades: list, total: list.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST endpoints - para usar desde localhost
app.post('/api/trade/open', async (req, res) => {
  try {
    const { symbol, side, quantity, leverage, usdtAmount } = req.body;
    if (!symbol || !side) {
      return res.status(400).json({ error: 'Requeridos: symbol, side' });
    }
    if (!quantity && !usdtAmount) {
      return res.status(400).json({ error: 'Requerido: quantity o usdtAmount' });
    }
    const price = getPrice(symbol);
    if (!price || price <= 0) return res.status(400).json({ error: `No hay precio disponible para ${symbol}` });
    const qty = usdtAmount > 0
      ? parseFloat((usdtAmount / price).toFixed(6))
      : parseFloat(quantity || 0);
    const position = await openMarketOrder({
      symbol, side, quantity: qty, leverage: parseFloat(leverage) || 1,
    });
    res.json({ success: true, position });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/trade/close', async (req, res) => {
  try {
    const { positionId } = req.body;
    if (!positionId) return res.status(400).json({ error: 'positionId requerido' });
    const trade = await closePosition(positionId);
    res.json({ success: true, trade });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post('/api/strategy/start', async (req, res) => {
  if (autoTradeEnabled) return res.json({ status: 'already_running' });
  strategy = new SimpleStrategy();
  autoTradeEnabled = true;
  strategyInterval = setInterval(runStrategy, 1000);
  strategyLog('Estrategia INICIADA - buscando dips cada 1s, $200/trade', 'start');
  await set('config', {
    symbols: getAllSymbols(),
    strategyActive: true,
    strategyName: strategy.name,
    lastEvaluation: Date.now(),
    updatedAt: Date.now(),
  });
  runStrategy();
  res.json({ status: 'started', strategy: strategy.name });
});

app.post('/api/strategy/stop', async (req, res) => {
  autoTradeEnabled = false;
  if (strategyInterval) { clearInterval(strategyInterval); strategyInterval = null; }
  await set('config', {
    symbols: getAllSymbols(),
    strategyActive: false,
    strategyName: strategy ? strategy.name : null,
    lastEvaluation: Date.now(),
    updatedAt: Date.now(),
  });
  console.log('[Estrategia] Estrategia DETENIDA');
  res.json({ status: 'stopped' });
});

app.post('/api/reset', async (req, res) => {
  try {
    await resetSimulator();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;

async function start() {
  await initDB();
  await remove('strategyLog');
  await set('serverStatus', {
    online: true,
    startedAt: Date.now(),
    symbols: getAllSymbols(),
    port: PORT,
  });
  console.log(`[Server] Símbolos: ${getAllSymbols().join(', ')}`);
  startPricePolling();

  const intervals = [
    setInterval(updateUnrealizedPnl, 1000),
    setInterval(processTradeRequests, 1000),
    setInterval(async () => {
      await set('serverStatus/online', true).catch(() => {});
      await set('serverStatus/lastBeat', Date.now()).catch(() => {});
    }, 10000),
  ];

  // Cleanup on shutdown
  const cleanup = async () => {
    console.log('[Server] Apagando...');
    await set('serverStatus/online', false).catch(() => {});
    intervals.forEach(clearInterval);
    stopPricePolling();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  app.listen(PORT, () => {
    console.log(`[Server] API en http://localhost:${PORT}`);
    console.log('[Server] Simulador de trading listo');
  });
}

start().catch(console.error);
