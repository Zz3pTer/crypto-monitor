// Rules R1-R7, score, BUY/HOLD/SELL with hysteresis, and events (spec 4.4).
// Mirror of python/signals.py; change both together. Candles are completed
// daily candles, oldest first: {open, high, low, close, volume, ...}.
// The dashboard runs this on today's still-forming candle to get the
// provisional signal.

import * as ind from "./indicators.js";

export const RULES = ["trend", "cross", "macd", "rsi", "bollinger", "momentum", "volume"];
export const BUY = "BUY", HOLD = "HOLD", SELL = "SELL";
export const INDICATOR_KEYS = ["sma50", "sma200", "ema20", "rsi14", "macd", "macd_signal", "macd_hist",
  "bb_upper", "bb_middle", "bb_lower", "roc14", "vol_ratio"];

export function computeIndicators(candles, sigCfg) {
  const p = sigCfg.periods;
  const closes = candles.map((c) => Number(c.close));
  const volumes = candles.map((c) => Number(c.volume));
  const [macdLine, macdSig, macdHist] = ind.macd(closes, p.macd_fast, p.macd_slow, p.macd_signal);
  const [bbUpper, bbMid, bbLower] = ind.bollinger(closes, p.bb, p.bb_std);
  return {
    close: closes,
    volume: volumes,
    sma50: ind.sma(closes, p.sma_fast),
    sma200: ind.sma(closes, p.sma_slow),
    ema20: ind.ema(closes, p.ema),
    rsi14: ind.rsi(closes, p.rsi),
    macd: macdLine,
    macd_signal: macdSig,
    macd_hist: macdHist,
    bb_upper: bbUpper,
    bb_middle: bbMid,
    bb_lower: bbLower,
    roc14: ind.roc(closes, p.roc),
    vol_ratio: ind.volumeRatio(volumes, p.vol_avg),
  };
}

const signVote = (bullish, bearish) => (bullish ? 1 : bearish ? -1 : 0);

// Votes of R1-R7 on day t, or null if any input is not available yet.
export function votesAt(series, t, sigCfg) {
  if (t < 1) return null;
  const need = ["sma50", "sma200", "rsi14", "macd", "macd_signal", "bb_upper", "bb_lower", "roc14", "vol_ratio"];
  if (need.some((k) => series[k][t] === null) || series.macd_hist[t] === null || series.macd_hist[t - 1] === null) {
    return null;
  }
  const s = {};
  for (const k of Object.keys(series)) s[k] = series[k][t];
  const close = s.close, prevClose = series.close[t - 1];
  const hist = s.macd_hist, prevHist = series.macd_hist[t - 1];
  const spike = s.vol_ratio > sigCfg.volume_spike;
  return {
    trend: signVote(close > s.sma200, close < s.sma200),
    cross: signVote(s.sma50 > s.sma200, s.sma50 < s.sma200),
    macd: signVote(s.macd > s.macd_signal && hist > prevHist, s.macd < s.macd_signal && hist < prevHist),
    rsi: signVote(s.rsi14 < sigCfg.rsi_oversold, s.rsi14 > sigCfg.rsi_overbought),
    bollinger: signVote(close < s.bb_lower, close > s.bb_upper),
    momentum: signVote(s.roc14 > sigCfg.roc_pct, s.roc14 < -sigCfg.roc_pct),
    volume: signVote(spike && close > prevClose, spike && close < prevClose),
  };
}

export function scoreOf(votes, sigCfg) {
  let total = 0;
  for (const r of RULES) total += votes[r] * sigCfg.weights[r];
  return Math.trunc(total);
}

// Score -> [signal, strong]. A BUY or SELL only falls back to HOLD once the
// score is `hysteresis` points back inside the threshold (FR-SIG-03).
export function classify(score, previous, sigCfg) {
  const th = sigCfg.thresholds;
  const h = sigCfg.hysteresis;
  let signal;
  if (score >= th.buy) signal = BUY;
  else if (score <= th.sell) signal = SELL;
  else if (previous === BUY && score >= th.buy - h) signal = BUY;
  else if (previous === SELL && score <= th.sell + h) signal = SELL;
  else signal = HOLD;
  const strong = (signal === BUY && score >= th.strong_buy) || (signal === SELL && score <= th.strong_sell);
  return [signal, strong];
}

// FR-SIG-06 flags for day t.
export function eventsAt(series, t, signal, previous, sigCfg) {
  const events = [];
  if (previous !== null && previous !== undefined && signal !== previous) events.push("signal_changed");
  const fast = series.sma50, slow = series.sma200;
  const lookback = sigCfg.cross_lookback_days ?? 3;
  for (let k = 0; k < lookback; k++) {
    const a = t - k, b = t - k - 1;
    if (b < 0 || [fast[a], slow[a], fast[b], slow[b]].includes(null)) break;
    if (fast[b] <= slow[b] && fast[a] > slow[a]) { events.push("golden_cross"); break; }
    if (fast[b] >= slow[b] && fast[a] < slow[a]) { events.push("death_cross"); break; }
  }
  const rNow = series.rsi14[t], rPrev = t >= 1 ? series.rsi14[t - 1] : null;
  if (rNow !== null && rPrev !== null) {
    if (rNow > sigCfg.rsi_overbought && sigCfg.rsi_overbought >= rPrev) events.push("rsi_overbought");
    if (rNow < sigCfg.rsi_oversold && sigCfg.rsi_oversold <= rPrev) events.push("rsi_oversold");
  }
  return events;
}

function insufficient(candles, previous) {
  return { status: "insufficient_history", message: "Not enough history", candles: candles.length, previous_signal: previous };
}

// Signal on the last candle. `previous` = yesterday's official signal.
export function evaluate(candles, sigCfg, previous = null) {
  if (candles.length < sigCfg.min_candles) return insufficient(candles, previous);
  const series = computeIndicators(candles, sigCfg);
  const t = candles.length - 1;
  const votes = votesAt(series, t, sigCfg);
  if (votes === null) return insufficient(candles, previous);
  const score = scoreOf(votes, sigCfg);
  const [signal, strong] = classify(score, previous, sigCfg);
  const indicators = {};
  for (const k of INDICATOR_KEYS) indicators[k] = series[k][t];
  return {
    status: "ok",
    close: series.close[t],
    score,
    signal,
    strong,
    previous_signal: previous,
    changed: previous !== null && signal !== previous,
    indicators,
    votes,
    events: eventsAt(series, t, signal, previous, sigCfg),
  };
}

// Signal for every day, carrying hysteresis forward. Day t only uses candles 0..t.
export function evaluateSeries(candles, sigCfg) {
  const series = computeIndicators(candles, sigCfg);
  const out = new Array(candles.length).fill(null);
  let previous = null;
  for (let t = 0; t < candles.length; t++) {
    if (t + 1 < sigCfg.min_candles) continue;
    const votes = votesAt(series, t, sigCfg);
    if (votes === null) continue;
    const score = scoreOf(votes, sigCfg);
    const [signal, strong] = classify(score, previous, sigCfg);
    out[t] = { close: series.close[t], score, signal, strong, votes };
    previous = signal;
  }
  return out;
}
