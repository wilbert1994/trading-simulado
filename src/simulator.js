const { v4: uuidv4 } = require('uuid');
const { get, set, update, remove, refs, readRef } = require('./firebase');
const { getPrice } = require('./binance');

async function getPortfolio() {
  const portfolio = await readRef(refs.portfolio);
  return portfolio || { balance: parseFloat(process.env.INITIAL_BALANCE || '2000'), initialBalance: parseFloat(process.env.INITIAL_BALANCE || '2000'), totalPnl: 0, totalPnlPercent: 0, usedMargin: 0, openPositions: 0 };
}

async function getBalance() {
  const p = await getPortfolio();
  return p.balance;
}

async function getUserPositions() {
  return await readRef(refs.positions) || {};
}

async function openMarketOrder({ symbol, side, quantity, leverage = 1 }) {
  symbol = symbol.toUpperCase();
  const price = getPrice(symbol);
  if (!price) throw new Error(`No hay precio disponible para ${symbol}`);

  const portfolio = await getPortfolio();
  const existingPositions = await getUserPositions();

  // Calculate total used margin across all open positions
  let totalUsedMargin = 0;
  for (const p of Object.values(existingPositions)) {
    if (p.status === 'OPEN') totalUsedMargin += p.initialMargin;
  }

  const margin = (price * quantity) / leverage;
  const available = portfolio.balance - totalUsedMargin;

  if (margin > available) {
    throw new Error(
      `Saldo insuficiente. Requerido: ${margin.toFixed(2)} USDT, Disponible: ${available.toFixed(2)} USDT`
    );
  }

  const existingForSymbol = Object.values(existingPositions).find(
    p => p.symbol === symbol && p.status === 'OPEN'
  );
  if (existingForSymbol) {
    throw new Error(`Ya tienes una posición abierta en ${symbol}. Ciérrala antes de abrir otra.`);
  }

  const positionId = uuidv4();
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
      ? (leverage <= 1 ? 0 : price * (1 - 1 / leverage + 0.01))
      : (leverage <= 1 ? Infinity : price * (1 + 1 / leverage - 0.01)),
  };

  await set(`positions/${positionId}`, position);

  const openCount = Object.values(existingPositions).filter(p => p.status === 'OPEN').length + 1;
  totalUsedMargin += margin;

  await update('portfolio', {
    usedMargin: parseFloat(totalUsedMargin.toFixed(8)),
    openPositions: openCount,
    lastUpdated: Date.now(),
  });

  return position;
}

async function closePosition(positionId) {
  const position = await get(`positions/${positionId}`);
  if (!position) throw new Error('Posición no encontrada');
  if (position.status !== 'OPEN') throw new Error('Esta posición ya está cerrada');

  const price = getPrice(position.symbol);
  const closePrice = price || position.markPrice;

  let pnl;
  if (position.side === 'LONG') {
    pnl = (closePrice - position.entryPrice) * position.quantity;
  } else {
    pnl = (position.entryPrice - closePrice) * position.quantity;
  }
  const pnlPercent = (pnl / position.initialMargin) * 100;

  const portfolio = await getPortfolio();
  const newBalance = portfolio.balance + pnl;

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

  const allTrades = await readRef(refs.trades) || {};
  const totalPnl = Object.values(allTrades).reduce((sum, t) => {
    if (typeof t.pnl === 'number') sum += t.pnl;
    return sum;
  }, 0);

  const remainingPositions = await getUserPositions();
  const openPositions = remainingPositions ? Object.values(remainingPositions).filter(p => p.status === 'OPEN') : [];
  const usedMargin = openPositions.reduce((sum, p) => sum + (p.initialMargin || 0), 0);

  await update('portfolio', {
    balance: parseFloat(newBalance.toFixed(8)),
    usedMargin: parseFloat(usedMargin.toFixed(8)),
    openPositions: openPositions.length,
    totalPnl: parseFloat(totalPnl.toFixed(8)),
    totalPnlPercent: parseFloat(((totalPnl / portfolio.initialBalance) * 100).toFixed(2)),
    lastUpdated: Date.now(),
  });

  return trade;
}

// Updates position PnL + auto-close + portfolio aggregate
async function updateUnrealizedPnl() {
  try {
    const positions = await getUserPositions();
    if (!positions) return;

    const openPositions = Object.entries(positions).filter(([, p]) => p.status === 'OPEN');
    if (openPositions.length === 0) return;

    let updated = 0;
    let totalUnrealizedPnl = 0;
    let totalMargin = 0;

    for (const [id, pos] of openPositions) {
      const price = getPrice(pos.symbol);
      if (!price) continue;
      updated++;

      const pnl = pos.side === 'LONG'
        ? (price - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - price) * pos.quantity;
      const pnlPercent = (pnl / pos.initialMargin) * 100;
      const peakPnlPercent = Math.max(pos.peakPnlPercent || 0, pnlPercent);
      const trailDistance = parseFloat(process.env.TRAIL_DISTANCE || '1');

      totalUnrealizedPnl += pnl;
      totalMargin += pos.initialMargin;

      await update(`positions/${id}`, {
        markPrice: price,
        unrealizedPnl: parseFloat(pnl.toFixed(8)),
        unrealizedPnlPercent: parseFloat(pnlPercent.toFixed(2)),
        peakPnlPercent: parseFloat(peakPnlPercent.toFixed(2)),
      });

      let autoClose = false;
      if (pnlPercent >= 5) {
        autoClose = true;
      } else if (peakPnlPercent >= 2 && (peakPnlPercent - pnlPercent) > trailDistance) {
        autoClose = true;
      }
      if (autoClose) {
        const trade = await closePosition(id);
        console.log(`[Auto-close] ${pos.symbol} | PnL: $${trade.pnl.toFixed(4)} (${trade.pnlPercent.toFixed(2)}%)`);
      }
    }

    const portfolio = await getPortfolio();
    if (portfolio) {
      const equity = portfolio.balance + totalUnrealizedPnl;
      const totalEquityPnlPercent = ((totalUnrealizedPnl + (portfolio.totalPnl || 0)) / portfolio.initialBalance) * 100;
      await update('portfolio', {
        equity: parseFloat(equity.toFixed(8)),
        usedMargin: parseFloat(totalMargin.toFixed(8)),
        unrealizedPnl: parseFloat(totalUnrealizedPnl.toFixed(8)),
        equityPnlPercent: parseFloat(totalEquityPnlPercent.toFixed(2)),
        lastUpdated: Date.now(),
      });
    }

    updateUnrealizedPnl._count = (updateUnrealizedPnl._count || 0) + 1;
    if (updateUnrealizedPnl._count % 30 === 0) {
      console.log(`[P&L] ${updated}/${openPositions.length} posiciones | PnL: $${totalUnrealizedPnl.toFixed(4)}`);
    }
  } catch (err) {
    console.error('[P&L] Error:', err.message);
  }
}

async function resetSimulator() {
  await remove('positions');
  await remove('trades');
  await remove('orders');
  const initialBalance = parseFloat(process.env.INITIAL_BALANCE || '2000');
  await set('portfolio', {
    balance: initialBalance,
    initialBalance,
    totalPnl: 0,
    totalPnlPercent: 0,
    usedMargin: 0,
    openPositions: 0,
    equity: initialBalance,
    unrealizedPnl: 0,
    equityPnlPercent: 0,
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
