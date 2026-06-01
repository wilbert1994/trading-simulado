const { set } = require('./firebase');

const REST_URL = process.env.BINANCE_REST_URL || 'https://fapi.binance.com';
const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
  .split(',')
  .map(s => s.trim().toUpperCase());

const priceCache = {};
let pollInterval = null;

async function fetchPrices() {
  for (const symbol of symbols) {
    try {
      const [tickerRes, priceRes] = await Promise.all([
        fetch(`${REST_URL}/fapi/v1/ticker/24hr?symbol=${symbol}`),
        fetch(`${REST_URL}/fapi/v1/ticker/price?symbol=${symbol}`),
      ]);

      const ticker = await tickerRes.json();
      const priceData = await priceRes.json();

      priceCache[symbol] = {
        price: parseFloat(priceData.price),
        change24h: parseFloat(ticker.priceChangePercent || 0),
        high24h: parseFloat(ticker.highPrice || 0),
        low24h: parseFloat(ticker.lowPrice || 0),
        volume24h: parseFloat(ticker.quoteVolume || 0),
        bid: parseFloat(ticker.bidPrice || 0),
        ask: parseFloat(ticker.askPrice || 0),
        timestamp: Date.now(),
      };

      set(`prices/${symbol}`, priceCache[symbol]).catch(() => {});
    } catch (err) {
      // precio no disponible por ahora
    }
  }
}

function startPricePolling() {
  fetchPrices();
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
