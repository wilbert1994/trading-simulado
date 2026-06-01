const WebSocket = require('ws');
const https = require('https');
const { set } = require('./firebase');

const REST_URL = 'https://fapi.binance.com';
const CG_URL = 'https://api.coingecko.com/api/v3';
const WS_URL = 'wss://stream.binance.com:9443/stream';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT,MOODENGUSDT,PENGUUSDT,MEMEUSDT,BRETTUSDT,TURBOUSDT,1000CHEEMSUSDT,MEWUSDT,DOGEUSDT,1000LUNCUSDT,1000RATSUSDT,COWUSDT,NEIROUSDT,SWARMSUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let ws = null;
let wsReconnectTimer = null;
let pollInterval = null;
let fetching = false;
let useBinance = false;

const CG_IDS = {
  BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum', '1000PEPEUSDT': 'pepe', WIFUSDT: 'dogwifcoin',
  '1000BONKUSDT': 'bonk', '1000FLOKIUSDT': 'floki', MOODENGUSDT: 'moo-deng',
  PENGUUSDT: 'pudgy-penguins', MEMEUSDT: 'memecoin-2', BRETTUSDT: 'based-brett',
  TURBOUSDT: 'turbo', '1000CHEEMSUSDT': 'cheems-token', MEWUSDT: 'cat-in-a-dogs-world',
  DOGEUSDT: 'dogecoin', '1000LUNCUSDT': 'terra-luna', '1000RATSUSDT': 'rats',
  COWUSDT: 'cow-protocol', NEIROUSDT: 'neiro', SWARMSUSDT: 'swarms',
};

function parseTicker(t) {
  return { price: parseFloat(t.c), change24h: parseFloat(t.P || 0), high24h: parseFloat(t.h || 0),
    low24h: parseFloat(t.l || 0), volume24h: parseFloat(t.q || 0), bid: parseFloat(t.b || 0),
    ask: parseFloat(t.a || 0), timestamp: Date.now() };
}

function httpGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'TradingSimulado/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const streams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
  try {
    ws = new WebSocket(`${WS_URL}?streams=${streams}`);
    ws.on('open', () => console.log(`[WS] Conectado (${symbols.length})`));
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.stream && msg.data) {
          const sym = msg.stream.split('@')[0].toUpperCase();
          priceCache[sym] = parseTicker(msg.data);
          set(`prices/${sym}`, priceCache[sym]).catch(() => {});
        }
      } catch {}
    });
    ws.on('close', () => { scheduleReconnect(); });
    ws.on('error', () => { try { ws.close(); } catch {} });
  } catch { scheduleReconnect(); }
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWebSocket, 5000);
}

async function fetchBinanceAll() {
  const results = await Promise.all(symbols.map(async (sym) => {
    try {
      const t = await httpGet(`${REST_URL}/fapi/v1/ticker/24hr?symbol=${sym}`, 4000);
      if (!t.lastPrice || t.code) return null;
      return { sym, price: parseFloat(t.lastPrice), change24h: parseFloat(t.priceChangePercent || 0),
        high24h: parseFloat(t.highPrice || 0), low24h: parseFloat(t.lowPrice || 0),
        volume24h: parseFloat(t.quoteVolume || 0), bid: parseFloat(t.bidPrice || 0),
        ask: parseFloat(t.askPrice || 0) };
    } catch { return null; }
  }));
  let success = 0;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      const d = r.value;
      priceCache[d.sym] = { ...d, timestamp: Date.now() };
      set(`prices/${d.sym}`, priceCache[d.sym]).catch(() => {});
      success++;
    }
  }
  if (success > 0) console.log(`[Binance] ${success}/${symbols.length} precios`);
  return success;
}

async function fetchCoinGecko() {
  const ids = symbols.map(s => CG_IDS[s]).filter(Boolean).join(',');
  try {
    const path = `/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`;
    const data = await httpGet(`${CG_URL}${path}`, 10000);
    let ok = 0;
    for (const sym of symbols) {
      const id = CG_IDS[sym];
      if (data[id] && data[id].usd) {
        const multiplier = sym.startsWith('1000') ? 1000 : 1;
        priceCache[sym] = {
          price: data[id].usd * multiplier,
          change24h: data[id].usd_24h_change || 0, high24h: 0, low24h: 0,
          volume24h: (data[id].usd_24h_vol || 0) * multiplier, bid: 0, ask: 0, timestamp: Date.now(),
        };
        set(`prices/${sym}`, priceCache[sym]).catch(() => {});
        ok++;
      }
    }
    console.log(`[CG] ${ok}/${symbols.length} precios`);
    return ok > 0;
  } catch (err) {
    console.error('[CG] Error:', err.message);
    return false;
  }
}

async function fetchPrices() {
  if (fetching) return;
  fetching = true;
  try {
    if (useBinance) {
      const ok = await fetchBinanceAll();
      if (ok === 0) { useBinance = false; await fetchCoinGecko(); }
    } else {
      const ok = await fetchBinanceAll();
      if (ok > 0) { useBinance = true; }
      else { await fetchCoinGecko(); }
    }
  } catch(err) {
    console.error('[Fetch] Error:', err.message);
  } finally {
    fetching = false;
  }
}

function startPricePolling() {
  console.log('[Binance] Iniciando...');
  connectWebSocket();
  fetchPrices();
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

function getAllPrices() { return { ...priceCache }; }
function getAllSymbols() { return [...symbols]; }

module.exports = { startPricePolling, stopPricePolling, getPrice, getAllPrices, getAllSymbols };
