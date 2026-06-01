const { set } = require('./firebase');

const REST_URL = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let pollInterval = null;
let consecutiveErrors = 0;

async function fetchPrice(symbol, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${REST_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ticker = await res.json();

      return {
        price: parseFloat(ticker.lastPrice),
        change24h: parseFloat(ticker.priceChangePercent || 0),
        high24h: parseFloat(ticker.highPrice || 0),
        low24h: parseFloat(ticker.lowPrice || 0),
        volume24h: parseFloat(ticker.quoteVolume || 0),
        bid: parseFloat(ticker.bidPrice || 0),
        ask: parseFloat(ticker.askPrice || 0),
        timestamp: Date.now(),
      };
    } catch (err) {
      if (i < retries) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  return null;
}

async function fetchPrices() {
  let success = 0;
  for (const symbol of symbols) {
    const data = await fetchPrice(symbol);
    if (data) {
      priceCache[symbol] = data;
      set(`prices/${symbol}`, data).catch(() => {});
      success++;
    }
  }

  if (success === 0) {
    consecutiveErrors++;
    if (consecutiveErrors === 1 || consecutiveErrors % 30 === 0) {
      console.error(`[Binance] No se pudieron obtener precios (intento ${consecutiveErrors})`);
    }
  } else {
    consecutiveErrors = 0;
    if (success < symbols.length) {
      console.log(`[Binance] ${success}/${symbols.length} símbolos actualizados`);
    }
  }
}

function startPricePolling() {
  fetchPrices().then(() => console.log('[Binance] Primer fetch exitoso'));
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
