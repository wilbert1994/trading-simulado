const fetch = require('node-fetch');
const API_KEY = process.env.FIREBASE_API_KEY || '';
const DB_URL = process.env.FIREBASE_DATABASE_URL || '';

function dbPath(path) {
  return `${DB_URL}/${path}.json?auth=${API_KEY}`;
}

async function get(path) {
  const res = await fetch(dbPath(path));
  if (!res.ok) throw new Error(`Firebase GET ${path}: ${res.statusText}`);
  return res.json();
}

async function set(path, data) {
  const res = await fetch(dbPath(path), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Firebase SET ${path}: ${res.statusText}`);
  return res.json();
}

async function update(path, data) {
  const res = await fetch(dbPath(path), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Firebase UPDATE ${path}: ${res.statusText}`);
  return res.json();
}

async function push(path, data) {
  const res = await fetch(dbPath(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Firebase PUSH ${path}: ${res.statusText}`);
  return res.json();
}

async function remove(path) {
  const res = await fetch(dbPath(path), { method: 'DELETE' });
  if (!res.ok) throw new Error(`Firebase REMOVE ${path}: ${res.statusText}`);
  return res.json();
}

const refs = {
  portfolio: { path: 'portfolio' },
  positions: { path: 'positions' },
  trades: { path: 'trades' },
  prices: { path: 'prices' },
  orders: { path: 'orders' },
  config: { path: 'config' },
  tradeRequests: { path: 'tradeRequests' },
};

async function readRef(ref) {
  return get(ref.path);
}

async function initDB() {
  const portfolio = await get('portfolio');
  if (!portfolio || !portfolio.initialBalance) {
    const initialBalance = parseFloat(process.env.INITIAL_BALANCE || '2000');
    await set('portfolio', {
      balance: initialBalance,
      initialBalance,
      totalPnl: 0,
      totalPnlPercent: 0,
      openPositions: 0,
      lastUpdated: Date.now(),
    });
    console.log(`[Firebase] Portafolio inicializado con $${initialBalance}`);
  } else {
    console.log(`[Firebase] Portafolio conservado: $${portfolio.balance} (inicial: $${portfolio.initialBalance})`);
  }

  const cfg = await get('config');
  const symbols = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,1000PEPEUSDT,WIFUSDT,1000BONKUSDT,1000FLOKIUSDT,MOODENGUSDT,PENGUUSDT,MEMEUSDT,BRETTUSDT,TURBOUSDT,1000CHEEMSUSDT,MEWUSDT,DOGEUSDT').split(',');
  if (!cfg || !cfg.symbols) {
    await set('config', { symbols, updatedAt: Date.now() });
  }

  const existingPositions = await get('positions');
  if (existingPositions) {
    const openCount = Object.values(existingPositions).filter(p => p.status === 'OPEN').length;
    console.log(`[Firebase] ${openCount} posiciones abiertas conservadas`);
  }

  await remove('tradeRequests');
  console.log('[Firebase] Base de datos lista');
}

module.exports = { get, set, update, push, remove, refs, initDB, readRef };
