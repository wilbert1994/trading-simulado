const WebSocket = require('ws');
const https = require('https');
const { set, get } = require('./firebase');

const REST_URL = 'https://fapi.binance.com';
const CG_URL = 'https://api.coingecko.com/api/v3';
const WS_URL = 'wss://stream.binance.com:9443/stream';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT,MOODENGUSDT,PENGUUSDT,MEMEUSDT,BRETTUSDT,TURBOUSDT,1000CHEEMSUSDT,MEWUSDT,DOGEUSDT,1000LUNCUSDT,1000RATSUSDT,COWUSDT,NEIROUSDT,SWARMSUSDT,IOUSDT,ZKUSDT,1000XECUSDT,REZUSDT,ENAUSDT,STRKUSDT,LISTAUSDT,BOMEUSDT,USUALUSDT,1000SHIBUSDT,1000SATSUSDT,AIXBTUSDT,AVAAIUSDT,TRUMPUSDT,PEOPLEUSDT,GOATUSDT,PNUTUSDT,BIOUSDT,POPCATUSDT,MELANIAUSDT,BANUSDT,NOTUSDT,WUSDT,ICPUSDT,NEARUSDT,JTOUSDT,RENDERUSDT,JUPUSDT,OPUSDT,INJUSDT,ARKMUSDT,SEIUSDT,FETUSDT,FILUSDT,ALGOUSDT,AXSUSDT,TIAUSDT,PYTHUSDT,GMXUSDT,DOTUSDT,COMPUSDT,LDOUSDT,IMXUSDT,STGUSDT,BCHUSDT,YGGUSDT,ROSEUSDT,APTUSDT,BNBUSDT,SOLUSDT,CHZUSDT,AVAXUSDT,IOTAUSDT,FIDAUSDT,VTHOUSDT,RLCUSDT,CVCUSDT,POWRUSDT,ZRXUSDT,SANDUSDT,FLOWUSDT,TUSDT,HBARUSDT,ICXUSDT,CTSIUSDT,JOEUSDT,LPTUSDT,ADAUSDT,RAREUSDT,GTCUSDT,AUCTIONUSDT,1INCHUSDT,CKBUSDT,ARBUSDT,WAXPUSDT,ASTRUSDT,STXUSDT,OGNUSDT,MOVRUSDT,GRTUSDT,COTIUSDT,XMRUSDT,TLMUSDT,ANKRUSDT,LTCUSDT,ZILUSDT,MAGICUSDT,TRXUSDT,BATUSDT,CTKUSDT,IOSTUSDT,MTLUSDT,SNXUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let ws = null;
let wsReconnectTimer = null;
let pollInterval = null;
let fetching = false;

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
          set(`prices/${sym}`, priceCache[sym]).catch(e => console.error('[Binance] Firebase:', e.message));
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

async function fetchFromBinance() {
  try {
    let ok = 0;
    // Batch in groups of 10 to avoid rate limiting
    for (let i = 0; i < symbols.length; i += 10) {
      const batch = symbols.slice(i, i + 10);
      const results = await Promise.all(batch.map(async (sym) => {
        try {
          const t = await httpGet(`${REST_URL}/fapi/v1/ticker/24hr?symbol=${sym}`, 4000);
          if (!t.lastPrice || t.code) return null;
          return { sym, price: parseFloat(t.lastPrice), change24h: parseFloat(t.priceChangePercent || 0),
            high24h: parseFloat(t.highPrice || 0), low24h: parseFloat(t.lowPrice || 0),
            volume24h: parseFloat(t.quoteVolume || 0), bid: parseFloat(t.bidPrice || 0),
            ask: parseFloat(t.askPrice || 0) };
        } catch { return null; }
      }));
      for (const r of results) {
        if (r && r.sym) {
          priceCache[r.sym] = { ...r, timestamp: Date.now() };
          set(`prices/${r.sym}`, priceCache[r.sym]).catch(e => console.error('[Binance] Firebase:', e.message));
          ok++;
        }
      }
    }
    if (ok > 0) console.log(`[Binance] ${ok}/${symbols.length}`);
    return ok;
  } catch { return 0; }
}

async function fetchFromFirebase() {
  try {
    const fb = await get('prices');
    if (!fb) return 0;
    let ok = 0;
    for (const sym of symbols) {
      if (fb[sym] && fb[sym].price) {
        priceCache[sym] = fb[sym];
        ok++;
      }
    }
    if (ok > 0) console.log(`[FB] ${ok}/${symbols.length} precios`);
    return ok;
  } catch { return 0; }
}

async function fetchPrices() {
  if (fetching) return;
  fetching = true;
  try {
    // First try Binance Futures REST (works from non-cloud IPs)
    let ok = await fetchFromBinance();
    // Fallback: read prices synced from local server to Firebase
    if (ok === 0) {
      ok = await fetchFromFirebase();
    }
    // Stay silent if nothing works (will retry next cycle)
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

module.exports = { startPricePolling, stopPricePolling, getPrice, getAllPrices, getAllSymbols, fetchPrices };
