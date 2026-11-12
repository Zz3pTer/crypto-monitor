// Backtest in the browser, for coins that the weekly backtest has not covered
// yet (a coin added today). Mirrors python/backtest.py run_asset(); change both
// together. tests/backtest.test.js checks they agree.
import { evaluateSeries } from "./signals.js";
import { mytFields } from "./format.js";

const DAY = 365;
const round = (x, d) => { const f = 10 ** d; return Math.round(x * f) / f; };

export function settings(cfg) {
  const bt = cfg.backtest ?? {};
  return { years: bt.years ?? 2, horizons_days: bt.horizons_days ?? [7, 30], fee_pct: bt.fee_pct ?? 0.1 };
}

// Daily candles to download: the test period plus the indicator warm-up.
export const daysNeeded = (cfg) => Math.trunc(settings(cfg).years * DAY) + cfg.signal.min_candles;

export function runAsset(candles, sigCfg, bt) {
  const series = evaluateSeries(candles, sigCfg);
  const first = series.findIndex((d) => d);
  if (first < 0) return { status: "insufficient_history", message: "Not enough history", candles: candles.length };
  const end = candles.length - 1;
  const start = Math.max(first, end - Math.trunc(bt.years * DAY) + 1);
  const closes = candles.map((c) => Number(c.close));
  const sigs = series.map((d) => (d ? d.signal : null));

  const turns = [];
  for (let t = start; t <= end; t++) if (t > first && sigs[t] !== sigs[t - 1]) turns.push(t);
  const entries = { BUY: turns.filter((t) => sigs[t] === "BUY"), SELL: turns.filter((t) => sigs[t] === "SELL") };

  const horizons = bt.horizons_days.map((n) => {
    const row = { days: n };
    for (const [s, key] of [["BUY", "buy"], ["SELL", "sell"]]) {
      const rets = entries[s].filter((t) => t + n <= end).map((t) => closes[t + n] / closes[t] - 1);
      const right = rets.filter((r) => (s === "BUY" ? r > 0 : r < 0));
      row[`${key}_count`] = rets.length;
      row[`${key}_hit_rate`] = rets.length ? round(right.length / rets.length, 4) : null;
      row[`${key}_avg_change_pct`] = rets.length ? round((rets.reduce((a, b) => a + b, 0) / rets.length) * 100, 2) : null;
    }
    return row;
  });

  const fee = bt.fee_pct / 100;
  let equity = 1, held = false, trades = 0, daysIn = 0;
  for (let t = start; t <= end; t++) {
    if (held && t > start) { equity *= closes[t] / closes[t - 1]; daysIn += 1; }
    if (sigs[t] === "BUY" && !held) { held = true; trades += 1; equity *= 1 - fee; }
    else if (sigs[t] === "SELL" && held) { held = false; trades += 1; equity *= 1 - fee; }
  }

  const length = end - start;
  const date = (c) => mytFields(c.time + 86_400_000).iso;   // the MYT date its close made the signal official
  return {
    status: "ok",
    start: date(candles[start]),
    end: date(candles[end]),
    days: length,
    period: length >= DAY ? `${(length / DAY).toFixed(1)} years` : `${length} days`,
    short_history: length < Math.trunc(bt.years * DAY) - 1,
    signal_changes: turns.length,
    buy_signals: entries.BUY.length,
    sell_signals: entries.SELL.length,
    horizons,
    strategy_return_pct: round((equity - 1) * 100, 2),
    buy_hold_return_pct: round((closes[end] / closes[start] - 1) * 100, 2),
    trades,
    time_in_market_pct: length ? round((daysIn / length) * 100, 1) : 0,
    still_holding: held,
  };
}
