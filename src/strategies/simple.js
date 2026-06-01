class SimpleStrategy {
  constructor() {
    this.name = 'momentum-dip-buyer';
    this.state = {};
    this.logCount = 0;
    this.signalsFound = 0;
  }

  onPrice(symbol, price) {
    if (!this.state[symbol]) {
      this.state[symbol] = { prices: [] };
    }
    const s = this.state[symbol];
    s.prices.push(price);
    if (s.prices.length > 20) s.prices.shift();

    const signal = { signal: 'HOLD', symbol, price, progress: s.prices.length, maxNeeded: 6 };

    if (s.prices.length >= 6) {
      const recent = s.prices.slice(-4);
      const older = s.prices.slice(0, -2);
      if (older.length >= 2) {
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
        const changePct = ((recentAvg - olderAvg) / olderAvg) * 100;

        this.logCount++;
        if (this.logCount % 20 === 0) {
          console.log(`[Estrategia] Escaneando... ${symbol}: dip=${changePct.toFixed(4)}% (buscando <-0.03%)`);
        }

        if (changePct < -0.03) {
          signal.signal = 'BUY';
          this.signalsFound++;
          console.log(`>>> SEÑAL #${this.signalsFound}: BUY ${symbol} @ $${price} | dip=${changePct.toFixed(3)}%`);
        }
      }
    }

    return signal;
  }
}

module.exports = { SimpleStrategy };
