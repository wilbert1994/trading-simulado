const WebSocket = require('ws');
const { set } = require('./firebase');

const REST_URL = 'https://fapi.binance.com';
const WS_URL = 'wss://stream.binance.com:9443/stream';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT,MOODENGUSDT,PENGUUSDT,MEMEUSDT,BRETTUSDT,TURBOUSDT,1000CHEEMSUSDT,MEWUSDT,DOGEUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let ws = null;
let wsReconnectTimer = null;
let pollInterval = null;

function parseTicker(t) {
  return {
    price: parseFloat(t.c),
    change24h: parseFloat(t.P || 0),
    high24h: parseFloat(t.h || 0),
    low24h: parseFloat(t.l || 0),
    volume24h: parseFloat(t.q || 0),
    bid: parseFloat(t.b || 0),
    ask: parseFloat(t.a || 0),
    timestamp: Date.now(),
  };
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const streams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
  const url = `${WS_URL}?streams=${streams}`;

  try {
    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log(`[WS] Conectado a Binance WebSocket (${symbols.length} símbolos)`);
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.stream && msg.data) {
          const symbol = msg.stream.split('@')[0].toUpperCase();
          const ticker = parseTicker(msg.data);
          priceCache[symbol] = ticker;
          set(`prices/${symbol}`, ticker).catch(() => {});
        }
      } catch {}
    });

    ws.on('close', () => {
      console.log('[WS] Desconectado, reconectando en 3s...');
      scheduleReconnect();
    });

    ws.on('error', () => {
      ws.close();
    });
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWebSocket, 3000);
  // Fallback to REST polling if WebSocket is down
  if (!pollInterval && symbols.length > 0) {
    fetchPrices().then(() => console.log('[Binance] Fallback REST iniciado'));
    pollInterval = setInterval(fetchPrices, 1000);
  }
}

async function fetchSingle(symbol) {
  try {
    const url = `${REST_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const t = await res.json();
    return {
      price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent || 0),
      high24h: parseFloat(t.highPrice || 0),
      low24h: parseFloat(t.lowPrice || 0),
      volume24h: parseFloat(t.quoteVolume || 0),
      bid: parseFloat(t.bidPrice || 0),
      ask: parseFloat(t.askPrice || 0),
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

async function fetchPrices() {
  let ok = 0;
  const batch = [];
  for (const symbol of symbols) {
    const data = await fetchSingle(symbol);
    if (data) {
      priceCache[symbol] = data;
      batch.push(set(`prices/${symbol}`, data));
      ok++;
    }
  }
  Promise.allSettled(batch);
  if (ok === 0) console.error('[Binance] No se pudieron obtener precios');
}

// Writes all prices to Firebase at interval to keep DB in sync even if WS missed some
function startFirebaseSync() {
  setInterval(() => {
    const batch = [];
    for (const [symbol, data] of Object.entries(priceCache)) {
      batch.push(set(`prices/${symbol}`, data));
    }
    Promise.allSettled(batch);
  }, 1000);
}

function startPricePolling() {
  console.log('[Binance] Iniciando WebSocket + REST de precios...');
  connectWebSocket();
  startFirebaseSync();
  // REST polling always runs in parallel for futures-only symbols
  fetchPrices().then(() => console.log('[Binance] REST polling iniciado (1s)'));
  pollInterval = setInterval(fetchPrices, 1000);
}

function stopPricePolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}

function getPrice(symbol) {
  const data = priceCache[symbol.toUpperCase()];
  return data ? data.price : null;
}

function getAllPrices() {
  return { ...priceCache };
}

function getAllSymbols() {
  return [...symbols];
}

module.exports = { startPricePolling, stopPricePolling, getPrice, getAllPrices, getAllSymbols };
