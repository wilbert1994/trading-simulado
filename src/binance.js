const { set } = require('./firebase');

const REST_URL = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';
const CG_URL = 'https://api.coingecko.com/api/v3';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let pollInterval = null;
let useCoinGecko = false;

const CG_IDS = {
  BTCUSDT: 'bitcoin',
  ETHUSDT: 'ethereum',
  '1000PEPEUSDT': 'pepe',
  WIFUSDT: 'dogwifcoin',
  '1000BONKUSDT': 'bonk',
  '1000FLOKIUSDT': 'floki',
};

async function fetchFromBinance(symbol) {
  const res = await fetch(`${REST_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`, {
    signal: AbortSignal.timeout(8000),
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
}

async function fetchFromCoinGecko() {
  const ids = symbols.map(s => CG_IDS[s] || s.toLowerCase()).filter(Boolean).join(',');
  try {
    const res = await fetch(
      `${CG_URL}/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
      { signal: AbortSignal.timeout(10000) }
    );
    const data = await res.json();
    for (const [symbol, id] of Object.entries(CG_IDS)) {
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
      }
    }
    return true;
  } catch (err) {
    console.error('[CG] Error:', err.message);
    return false;
  }
}

async function fetchPrices() {
  if (useCoinGecko) {
    await fetchFromCoinGecko();
    return;
  }

  let success = 0;
  for (const symbol of symbols) {
    try {
      const data = await fetchFromBinance(symbol);
      priceCache[symbol] = data;
      set(`prices/${symbol}`, data).catch(() => {});
      success++;
    } catch (err) {}
  }

  if (success === 0) {
    console.log('[Binance] No accesible, cambiando a CoinGecko...');
    useCoinGecko = true;
  } else if (success > 0) {
    useCoinGecko = false;
  }
}

function startPricePolling() {
  fetchPrices();
  pollInterval = setInterval(fetchPrices, 5000);
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
