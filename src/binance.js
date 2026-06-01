const WebSocket = require('ws');
const { set } = require('./firebase');

const REST_URL = 'https://fapi.binance.com';
const CG_URL = 'https://api.coingecko.com/api/v3';
const WS_URL = 'wss://stream.binance.com:9443/stream';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT,MOODENGUSDT,PENGUUSDT,MEMEUSDT,BRETTUSDT,TURBOUSDT,1000CHEEMSUSDT,MEWUSDT,DOGEUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let ws = null;
let wsReconnectTimer = null;
let pollInterval = null;
let useCoinGecko = false;

const CG_IDS = {
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  '1000PEPEUSDT': 'pepe',
  WIFUSDT: 'dogwifcoin',
  '1000BONKUSDT': 'bonk',
  '1000FLOKIUSDT': 'floki',
  MOODENGUSDT: 'moo-deng',
  PENGUUSDT: 'pudgy-penguins',
  MEMEUSDT: 'memecoin-2',
  BRETTUSDT: 'based-brett',
  TURBOUSDT: 'turbo',
  '1000CHEEMSUSDT': 'cheems',
  MEWUSDT: 'cat-in-a-dogs-world',
  DOGEUSDT: 'dogecoin',
};

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

// ===== WebSocket =====
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const streams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
  const url = `${WS_URL}?streams=${streams}`;
  try {
    ws = new WebSocket(url);
    ws.on('open', () => {
      console.log(`[WS] Conectado (${symbols.length} símbolos)`);
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.stream && msg.data) {
          const sym = msg.stream.split('@')[0].toUpperCase();
          const ticker = parseTicker(msg.data);
          priceCache[sym] = ticker;
          set(`prices/${sym}`, ticker).catch(() => {});
        }
      } catch {}
    });
    ws.on('close', () => {
      console.log('[WS] Desconectado, reconectando en 3s...');
      scheduleReconnect();
    });
    ws.on('error', () => { ws.close(); });
  } catch {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWebSocket, 3000);
}

// ===== Binance REST =====
async function fetchFromBinance(symbol) {
  const res = await fetch(`${REST_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`, {
    signal: AbortSignal.timeout(8000),
  });
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
}

// ===== CoinGecko Fallback =====
async function fetchFromCoinGecko() {
  const ids = symbols.map(s => CG_IDS[s]).filter(Boolean).join(',');
  try {
    const res = await fetch(
      `${CG_URL}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let ok = 0;
    for (const symbol of symbols) {
      const id = CG_IDS[symbol];
      if (data[id]) {
        priceCache[symbol] = {
          price: data[id].usd,
          change24h: data[id].usd_24h_change || 0,
          high24h: 0,
          low24h: 0,
          volume24h: data[id].usd_24h_vol || 0,
          bid: 0,
          ask: 0,
          timestamp: Date.now(),
        };
        set(`prices/${symbol}`, priceCache[symbol]).catch(() => {});
        ok++;
      }
    }
    console.log(`[CG] ${ok}/${symbols.length} precios actualizados`);
    return true;
  } catch (err) {
    console.error('[CG] Error:', err.message);
    return false;
  }
}

let fetching = false;

// ===== Main Price Fetch =====
async function fetchPrices() {
  if (fetching) return;
  fetching = true;
  try {
    if (useCoinGecko) {
      await fetchFromCoinGecko();
      return;
    }

    const results = await Promise.allSettled(symbols.map(s => fetchFromBinance(s)));
    let success = 0;
    const batch = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        const sym = symbols[i];
        priceCache[sym] = results[i].value;
        batch.push(set(`prices/${sym}`, results[i].value));
        success++;
      }
    }
    Promise.allSettled(batch);

    if (success === 0) {
      console.log('[Binance] No accesible, cambiando a CoinGecko...');
      useCoinGecko = true;
    } else if (success > 0 && useCoinGecko) {
      console.log('[Binance] Restaurado, volviendo a Binance');
      useCoinGecko = false;
    }
  } finally {
    fetching = false;
  }
}

// ===== Firebase Sync =====
function startFirebaseSync() {
  setInterval(() => {
    const batch = [];
    for (const [sym, data] of Object.entries(priceCache)) {
      batch.push(set(`prices/${sym}`, data));
    }
    Promise.allSettled(batch);
  }, 8000);
}

// ===== Start / Stop =====
function startPricePolling() {
  console.log('[Binance] Iniciando WebSocket + REST + CoinGecko fallback...');
  connectWebSocket();
  startFirebaseSync();
  fetchPrices().then(() => console.log('[Binance] Polling iniciado'));
  pollInterval = setInterval(fetchPrices, 8000);
}

function stopPricePolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws) { ws.removeAllListeners(); ws.close(); ws = null; }
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
