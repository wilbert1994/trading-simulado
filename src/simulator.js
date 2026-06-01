const { v4: uuidv4 } = require('uuid');
const { get, set, update, push, remove, refs, readRef } = require('./firebase');
const { getPrice } = require('./binance');

async function getBalance() {
  const portfolio = await readRef(refs.portfolio);
  return portfolio ? portfolio.balance : parseFloat(process.env.INITIAL_BALANCE || '10000');
}

async function getUserPositions() {
  return await readRef(refs.positions) || {};
}

async function openMarketOrder({ symbol, side, quantity, leverage = 1 }) {
  symbol = symbol.toUpperCase();
  const price = getPrice(symbol);
  if (!price) {
    throw new Error(`No hay precio disponible para ${symbol}`);
  }

  const balance = await getBalance();
  const margin = (price * quantity) / leverage;

  if (margin > balance) {
    throw new Error(
      `Saldo insuficiente. Requerido: ${margin.toFixed(2)} USDT, Disponible: ${balance.toFixed(2)} USDT`
    );
  }

  const existingPositions = await getUserPositions();
  const existingForSymbol = Object.values(existingPositions).find(
    p => p.symbol === symbol && p.status === 'OPEN'
  );
  if (existingForSymbol) {
    throw new Error(`Ya tienes una posición abierta en ${symbol}. Ciérrala antes de abrir otra.`);
  }

  const positionId = uuidv4();
  const newBalance = balance - margin;

  const position = {
    id: positionId,
    symbol,
    side: side.toUpperCase(),
    entryPrice: price,
    markPrice: price,
    quantity,
    leverage: parseFloat(leverage),
    margin,
    initialMargin: margin,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    openTime: Date.now(),
    status: 'OPEN',
    liquidationPrice: side.toUpperCase() === 'LONG'
      ? price * (1 - 1 / leverage + 0.01)
      : price * (1 + 1 / leverage - 0.01),
  };

  await set(`positions/${positionId}`, position);

  const portfolio = await readRef(refs.portfolio);
  const openCount = existingPositions
    ? Object.values(existingPositions).filter(p => p.status === 'OPEN').length + 1
    : 1;

  await update('portfolio', {
    balance: parseFloat(newBalance.toFixed(8)),
    openPositions: openCount,
    lastUpdated: Date.now(),
  });

  return position;
}

async function closePosition(positionId) {
  const position = await get(`positions/${positionId}`);

  if (!position) {
    throw new Error('Posición no encontrada');
  }
  if (position.status !== 'OPEN') {
    throw new Error('Esta posición ya está cerrada');
  }

  const price = getPrice(position.symbol);
  const closePrice = price || position.markPrice;

  let pnl;
  if (position.side === 'LONG') {
    pnl = (closePrice - position.entryPrice) * position.quantity;
  } else {
    pnl = (position.entryPrice - closePrice) * position.quantity;
  }

  const pnlPercent = (pnl / position.initialMargin) * 100;

  const balance = await getBalance();
  const newBalance = balance + position.margin + pnl;

  const trade = {
    id: uuidv4(),
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: closePrice,
    quantity: position.quantity,
    leverage: position.leverage,
    initialMargin: position.initialMargin,
    pnl: parseFloat(pnl.toFixed(8)),
    pnlPercent: parseFloat(pnlPercent.toFixed(2)),
    openTime: position.openTime,
    closeTime: Date.now(),
    type: 'MARKET',
  };

  await update(`positions/${positionId}`, { status: 'CLOSED', exitPrice: closePrice });
  await set(`trades/${trade.id}`, trade);

  const portfolio = await readRef(refs.portfolio);
  const allTrades = await readRef(refs.trades);
  const allTradesList = allTrades || {};
  const totalPnl = Object.values(allTradesList).reduce((sum, t) => {
    if (typeof t.pnl === 'number') sum += t.pnl;
    return sum;
  }, 0);

  const remainingPositions = await getUserPositions();
  const openCount = remainingPositions
    ? Object.values(remainingPositions).filter(p => p.status === 'OPEN').length
    : 0;

  await update('portfolio', {
    balance: parseFloat(newBalance.toFixed(8)),
    openPositions: openCount,
    totalPnl: parseFloat(totalPnl.toFixed(8)),
    totalPnlPercent: parseFloat(((totalPnl / portfolio.initialBalance) * 100).toFixed(2)),
    lastUpdated: Date.now(),
  });

  return trade;
}

async function updateUnrealizedPnl() {
  try {
    const positions = await getUserPositions();
    if (!positions) {
      console.log('[P&L] No hay posiciones en Firebase');
      return;
    }

    const openPositions = Object.entries(positions).filter(([, p]) => p.status === 'OPEN');
    if (openPositions.length === 0) return;

    let updated = 0;
    for (const [id, pos] of openPositions) {
      const price = getPrice(pos.symbol);
      if (!price) continue;
      updated++;

    let pnl;
    if (pos.side === 'LONG') {
      pnl = (price - pos.entryPrice) * pos.quantity;
    } else {
      pnl = (pos.entryPrice - price) * pos.quantity;
    }

    const pnlPercent = (pnl / pos.initialMargin) * 100;

    await update(`positions/${id}`, {
      markPrice: price,
      unrealizedPnl: parseFloat(pnl.toFixed(8)),
      unrealizedPnlPercent: parseFloat(pnlPercent.toFixed(2)),
    });
  }

  // Log cada 30 ejecuciones (~1 minuto)
  updateUnrealizedPnl._count = (updateUnrealizedPnl._count || 0) + 1;
  if (updateUnrealizedPnl._count % 30 === 0) {
    console.log(`[P&L] ${updated}/${openPositions.length} posiciones actualizadas`);
  }
  } catch (err) {
    console.error('[P&L] Error:', err.message);
  }
}

async function resetSimulator() {
  await remove('positions');
  await remove('trades');
  await remove('orders');
  const initialBalance = parseFloat(process.env.INITIAL_BALANCE || '10000');
  await update('portfolio', {
    balance: initialBalance,
    totalPnl: 0,
    totalPnlPercent: 0,
    openPositions: 0,
    lastUpdated: Date.now(),
  });
}

module.exports = {
  getBalance,
  getUserPositions,
  openMarketOrder,
  closePosition,
  updateUnrealizedPnl,
  resetSimulator,
};
