// Technical indicators, exactly as in spec Appendix A.
//
// Line-by-line copy of python/indicators.py: same loops, same order of
// arithmetic, so both give the same numbers (FR-SIG-05). Change both together.
// Inputs are arrays of numbers (oldest first); outputs have the same length,
// with null where there is not yet enough data.

export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  for (let t = n - 1; t < values.length; t++) {
    let s = 0.0;
    let missing = false;
    for (let i = t - n + 1; i <= t; i++) {
      if (values[i] === null) { missing = true; break; }
      s += values[i];
    }
    if (!missing) out[t] = s / n;
  }
  return out;
}

// alpha = 2/(n+1), seeded with the SMA of the first n available values.
// Leading nulls (e.g. MACD warm-up) are skipped.
export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  let start = 0;
  while (start < values.length && values[start] === null) start++;
  const first = start + n - 1;
  if (first >= values.length) return out;
  let s = 0.0;
  for (let t = start; t <= first; t++) s += values[t];
  let prev = s / n;
  out[first] = prev;
  const alpha = 2.0 / (n + 1);
  for (let t = first + 1; t < values.length; t++) {
    prev = alpha * values[t] + (1.0 - alpha) * prev;
    out[t] = prev;
  }
  return out;
}

function rsiValue(avgGain, avgLoss) {
  if (avgLoss === 0.0) return avgGain === 0.0 ? 50.0 : 100.0;
  const rs = avgGain / avgLoss;
  return 100.0 - 100.0 / (1.0 + rs);
}

// Wilder's RSI: first averages = plain mean of the first n gains/losses,
// then Avg(t) = (Avg(t-1) * (n-1) + value(t)) / n.
export function rsi(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let avgGain = 0.0;
  let avgLoss = 0.0;
  for (let t = 1; t <= n; t++) {
    const change = closes[t] - closes[t - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= n;
  avgLoss /= n;
  out[n] = rsiValue(avgGain, avgLoss);
  for (let t = n + 1; t < closes.length; t++) {
    const change = closes[t] - closes[t - 1];
    const gain = change > 0 ? change : 0.0;
    const loss = change < 0 ? -change : 0.0;
    avgGain = (avgGain * (n - 1) + gain) / n;
    avgLoss = (avgLoss * (n - 1) + loss) / n;
    out[t] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

// MACD = EMA(fast) - EMA(slow); signal = EMA(signal) of MACD; histogram = MACD - signal.
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const line = emaFast.map((f, i) => (f !== null && emaSlow[i] !== null ? f - emaSlow[i] : null));
  const sig = ema(line, signal);
  const hist = line.map((m, i) => (m !== null && sig[i] !== null ? m - sig[i] : null));
  return [line, sig, hist];
}

// Middle = SMA(n); upper/lower = middle +/- k * population standard deviation of the last n closes.
export function bollinger(closes, n = 20, k = 2) {
  const mid = sma(closes, n);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let t = n - 1; t < closes.length; t++) {
    const m = mid[t];
    let ss = 0.0;
    for (let i = t - n + 1; i <= t; i++) {
      const d = closes[i] - m;
      ss += d * d;
    }
    const sd = Math.sqrt(ss / n);
    upper[t] = m + k * sd;
    lower[t] = m - k * sd;
  }
  return [upper, mid, lower];
}

// Rate of change in percent: (C(t) / C(t-n) - 1) * 100.
export function roc(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  for (let t = n; t < closes.length; t++) {
    if (closes[t - n] !== 0) out[t] = (closes[t] / closes[t - n] - 1.0) * 100.0;
  }
  return out;
}

// Today's volume divided by the n-day average volume (the average includes today).
export function volumeRatio(volumes, n = 20) {
  const avg = sma(volumes, n);
  return volumes.map((v, i) => (avg[i] !== null && avg[i] > 0 ? v / avg[i] : null));
}
