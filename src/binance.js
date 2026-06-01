const WebSocket = require('ws');
const https = require('https');
const { set } = require('./firebase');

const REST_URL = 'https://fapi.binance.com';
const CG_HOST = 'api.coingecko.com';
const WS_URL = 'wss://stream.binance.com:9443/stream';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT,MOODENGUSDT,PENGUUSDT,MEMEUSDT,BRETTUSDT,TURBOUSDT,1000CHEEMSUSDT,MEWUSDT,DOGEUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let ws = null;
let wsReconnectTimer = null;
let pollInterval = null;
let useCoinGecko = true;
let fetching = false;

// ===== Main Fetch =====
async function fetchPrices() {
  if (fetching) return;
  fetching = true;
  try {
    // Try Binance once every 5 cycles (40s) to see if it comes back
    if (!useCoinGecko || (fetchPrices._cycles = (fetchPrices._cycles || 0) + 1) % 5 === 0) {
      const results = await Promise.all(symbols.map(s => fetchFromBinance(s).then(d => ({ s, d }), () => ({ s, d: null }))));
      let success = 0;
      for (const { s, d } of results) {
        if (d) { priceCache[s] = d; success++; }
      }
      if (success > 0) {
        console.log(`[Binance] ${success}/${symbols.length} ok, usando Binance`);
        useCoinGecko = false;
        fetching = false;
        return;
      } else if (!useCoinGecko) {
        console.log('[Binance] Falló, volviendo a CoinGecko');
      }
      useCoinGecko = true;
    }

    // Primary: CoinGecko
    await fetchFromCoinGecko();
  } catch(err) {
    console.error('[Fetch] Error:', err.message);
  } finally {
    fetching = false;
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: 8000,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TradingSimulado/1.0',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ===== WebSocket =====
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const streams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
  const url = `${WS_URL}?streams=${streams}`;
  try {
    ws = new WebSocket(url);
    ws.on('open', () => console.log(`[WS] Conectado (${symbols.length} símbolos)`));
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
    ws.on('close', () => { console.log('[WS] Desconectado, reconectando...'); scheduleReconnect(); });
    ws.on('error', () => { ws.close(); });
  } catch { scheduleReconnect(); }
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWebSocket, 3000);
}

// ===== Binance REST (https) =====
async function fetchFromBinance(symbol) {
  try {
    const t = await httpGet(`${REST_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`);
    if (!t.lastPrice && t.code) throw new Error(`Binance error ${t.code}: ${t.msg}`);
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
  } catch(e) { console.log(`[Binance] ${symbol} FAIL: ${e.message}`); return null; }
}

// ===== CoinGecko Fallback =====
async function fetchFromCoinGecko() {
  const ids = symbols.map(s => CG_IDS[s]).filter(Boolean).join(',');
  try {
    const path = `/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
    const data = await httpGet(`https://${CG_HOST}${path}`);
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
    console.log(`[CG] ${ok}/${symbols.length} precios`);
    return true;
  } catch (err) {
    console.error('[CG] Error:', err.message);
    return false;
  }
}

// ===== Main Fetch =====
async function fetchPrices() {
  if (fetching) return;
  fetching = true;
  try {
    // Try Binance once every 5 cycles (~40s) to see if it recovers
    if (!useCoinGecko || ((fetchPrices._cycles = (fetchPrices._cycles || 0) + 1) % 5 === 0)) {
      const results = await Promise.all(symbols.map(s => fetchFromBinance(s).then(d => ({ s, d }), () => ({ s, d: null }))));
      let success = 0;
      for (const { s, d } of results) {
        if (d) { priceCache[s] = d; set(`prices/${s}`, d).catch(() => {}); success++; }
      }
      if (success > 0) {
        console.log(`[Binance] ${success}/${symbols.length} ok`);
        useCoinGecko = false;
        fetching = false;
        return;
      } else {
        useCoinGecko = true;
      }
    }

    // Default: CoinGecko
    await fetchFromCoinGecko();
  } catch(err) {
    console.error('[Fetch] Error:', err.message);
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
  fetchPrices().then(() => {});
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
