const { set } = require('./firebase');

const REST_URL = 'https://fapi.binance.com';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let pollInterval = null;

async function fetchSingle(symbol) {
  try {
    const url = `${REST_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
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
  } catch (err) {
    return null;
  }
}

async function fetchPrices() {
  let ok = 0;
  for (const symbol of symbols) {
    const data = await fetchSingle(symbol);
    if (data) {
      priceCache[symbol] = data;
      set(`prices/${symbol}`, data).catch(() => {});
      ok++;
    }
  }
  if (ok === 0) {
    console.error('[Binance] No se pudieron obtener precios');
  }
}

function startPricePolling() {
  fetchPrices().then(() => {
    if (Object.keys(priceCache).length > 0) {
      console.log(`[Binance] ${Object.keys(priceCache).length}/${symbols.length} símbolos funcionando`);
    }
  });
  pollInterval = setInterval(fetchPrices, 2000);
}

function stopPricePolling() {
  if (pollInterval) clearInterval(pollInterval);
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
