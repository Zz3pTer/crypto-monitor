// Market data for the dashboard. The provider sits behind this one module
// (FR-DATA-05): Binance public market data, live through its WebSocket
// stream, with REST polling as the fallback (FR-DATA-02/03).
//
// Prices are kept in memory here; the screen is repainted by app.js once per
// refresh interval, not on every tick.

const HOUR_MS = 3_600_000;

function kline(r) {
  return { time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5], closeTime: r[6] };
}

export class Feed {
  constructor(cfg, coins, onStatus = () => {}) {
    const p = cfg.data.providers.binance;
    this.rest = p.rest;
    this.wsBase = p.ws;
    this.minPoll = cfg.refresh.polling_min_sec ?? 5;
    this.coins = coins;
    this.onStatus = onStatus;
    this.assets = new Map(coins.map((c) => [c.symbol, { coin: c, ticker: null, daily: [], hourly: [], lastUpdate: 0, unavailable: false }]));
    this.byPair = new Map(coins.map((c) => [c.pair.toLowerCase(), c.symbol]));
    this.mode = "connecting";      // connecting | live | polling | down
    this.latencyMs = null;
    this.pollSec = null;
    this.retryInSec = 0;
    this._backoff = 1;
    this._ws = null;
    this._pollTimer = null;
    this._reconnectTimer = null;
  }

  async _get(path, params = {}) {
    const url = new URL(this.rest + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // Candles for the detail chart: interval is "1h", "4h", "1d" or "1w".
  // Binance gives at most 1000 per request, so longer periods are fetched in
  // parts, going back in time, until `limit` or the coin's first candle.
  // `endTime` (ms): only candles that start before it, for loading older history.
  async klines(pair, interval, limit = 500, endTime = null) {
    let rows = [], end = endTime;
    while (rows.length < limit) {
      const want = Math.min(limit - rows.length, 1000);
      const part = await this._get("/api/v3/klines", { symbol: pair, interval, limit: want, ...(end ? { endTime: end } : {}) });
      rows = part.concat(rows);
      if (part.length < want) break;
      end = part[0][0] - 1;
    }
    return rows.map(kline);
  }

  // ---------- history (charts, sparklines, provisional signal) ----------

  async loadHistory(dailyLimit = 260) {
    await Promise.all(this.coins.map(async (c) => {
      const a = this.assets.get(c.symbol);
      try {
        const [daily, hourly] = await Promise.all([
          this._get("/api/v3/klines", { symbol: c.pair, interval: "1d", limit: dailyLimit }),
          this._get("/api/v3/klines", { symbol: c.pair, interval: "1h", limit: 168 }),
        ]);
        a.daily = daily.map(kline);            // last one is today's still-forming candle
        a.hourly = hourly.map(kline);
        a.unavailable = false;
      } catch (e) {
        if (e.status === 400) a.unavailable = true;   // wrong pair: only this coin is affected (FR-CFG-08)
      }
    }));
  }

  // ---------- live stream ----------

  start() {
    this._connect();
    this._measureLatency();
    this._latencyTimer = setInterval(() => this._measureLatency(), 60_000);
  }

  _connect() {
    clearTimeout(this._reconnectTimer);
    const streams = this.coins.flatMap((c) => [`${c.pair.toLowerCase()}@ticker`, `${c.pair.toLowerCase()}@kline_1d`]);
    let ws;
    try {
      ws = new WebSocket(`${this.wsBase}/stream?streams=${streams.join("/")}`);
    } catch {
      this._wsFailed();
      return;
    }
    this._ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this._backoff = 1;
      this._stopPolling();
      this._setMode("live");
    };
    ws.onmessage = (ev) => {
      try { this._onMessage(JSON.parse(ev.data)); } catch { /* ignore a bad frame */ }
    };
    ws.onclose = () => {
      if (this._ws !== ws) return;
      this._ws = null;
      this._wsFailed(opened);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }

  _wsFailed() {
    // Fall back to REST polling straight away, and keep retrying the stream
    // with waits of 1 s, 2 s, 4 s … up to 60 s (FR-DATA-03).
    const wait = this._backoff;
    this._backoff = Math.min(this._backoff * 2, 60);
    this.retryInSec = wait;
    this._reconnectTimer = setTimeout(() => this._connect(), wait * 1000);
    this._startPolling();
  }

  _onMessage(msg) {
    const d = msg.data;
    if (!d) return;
    const sym = this.byPair.get(String(d.s).toLowerCase());
    const a = sym && this.assets.get(sym);
    if (!a) return;
    if (d.e === "24hrTicker") {
      a.ticker = { last: +d.c, changePct: +d.P, change: +d.p, high: +d.h, low: +d.l, volume: +d.v, quoteVolume: +d.q };
      this._updateHourly(a, +d.c);
    } else if (d.e === "kline") {
      const k = d.k;
      const c = { time: k.t, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, closeTime: k.T };
      const last = a.daily.at(-1);
      if (last && last.time === c.time) a.daily[a.daily.length - 1] = c;
      else if (!last || c.time > last.time) a.daily.push(c);   // new day after the 08:00 MYT close
    }
    a.lastUpdate = Date.now();
  }

  _updateHourly(a, price) {
    if (!a.hourly.length) return;
    const last = a.hourly.at(-1);
    const hourStart = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
    if (hourStart > last.time) {
      a.hourly.push({ time: hourStart, open: price, high: price, low: price, close: price, volume: 0 });
      if (a.hourly.length > 168) a.hourly.shift();
    } else {
      last.close = price;
    }
  }

  // ---------- REST polling fallback ----------

  async loadTickers() {
    const pairs = this.coins.map((c) => c.pair);
    let rows;
    try {
      rows = await this._get("/api/v3/ticker/24hr", { symbols: JSON.stringify(pairs) });
    } catch (e) {
      if (e.status !== 400) throw e;
      // One bad pair makes Binance refuse the whole batch: ask coin by coin.
      rows = (await Promise.allSettled(pairs.map((p) => this._get("/api/v3/ticker/24hr", { symbol: p }))))
        .filter((r) => r.status === "fulfilled").map((r) => r.value);
    }
    const now = Date.now();
    for (const r of rows) {
      const a = this.assets.get(this.byPair.get(r.symbol.toLowerCase()));
      if (!a) continue;
      const last = +r.lastPrice;
      a.ticker = { last, changePct: +r.priceChangePercent, change: +r.priceChange, high: +r.highPrice,
        low: +r.lowPrice, volume: +r.volume, quoteVolume: +r.quoteVolume };
      const day = a.daily.at(-1);
      if (day) { day.close = last; day.high = Math.max(day.high, last); day.low = Math.min(day.low, last); }
      this._updateHourly(a, last);
      a.lastUpdate = now;
    }
  }

  setPollInterval(sec) {
    // Never poll faster than the minimum, so the provider limit is safe (FR-REF-06).
    this.pollSec = Math.max(sec, this.minPoll);
    if (this._pollTimer) { this._stopPolling(); this._startPolling(); }
    return this.pollSec;
  }

  _startPolling() {
    if (this._pollTimer) return;
    const sec = this.pollSec ?? this.minPoll;
    const tick = async () => {
      try {
        await this.loadTickers();
        if (!this._ws || this._ws.readyState !== 1) this._setMode("polling");
      } catch {
        if (!this._ws || this._ws.readyState !== 1) this._setMode("down");
      }
    };
    tick();
    this._pollTimer = setInterval(tick, sec * 1000);
  }

  _stopPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  async _measureLatency() {
    const t0 = performance.now();
    try {
      await this._get("/api/v3/time");
      this.latencyMs = Math.round(performance.now() - t0);
    } catch {
      this.latencyMs = null;
    }
  }

  _setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.onStatus(mode);
  }
}
