// Chart period (how much history the detail chart shows) and candle size.
// Pure functions, so they can be tested. Dates follow the dashboard's time
// zone (MYT, UTC+8): 1Y on 12 Nov 2026 starts on 12 Nov 2025.

export const MYT_MS = 8 * 3_600_000;
export const WARMUP = 210;            // extra candles before the period, so SMA 200 etc. are right from its first day
export const MAX_BARS = 4000;         // most candles one chart loads

export const INTERVALS = [
  { key: "1H", api: "1h", label: "1h", ms: 3_600_000, name: "hourly" },
  { key: "4H", api: "4h", label: "4h", ms: 4 * 3_600_000, name: "4-hour" },
  { key: "1D", api: "1d", label: "1d", ms: 86_400_000, name: "daily" },
  { key: "1W", api: "1w", label: "1w", ms: 7 * 86_400_000, name: "weekly" },
];

// back: how far back the period starts, in calendar units.
export const RANGES = [
  { key: "1D", label: "1D", name: "1 day", back: { days: 1 } },
  { key: "1W", label: "1W", name: "1 week", back: { days: 7 } },
  { key: "1M", label: "1M", name: "1 month", back: { months: 1 } },
  { key: "3M", label: "3M", name: "3 months", back: { months: 3 } },
  { key: "6M", label: "6M", name: "6 months", back: { months: 6 } },
  { key: "YTD", label: "YTD", name: "this year so far", back: "ytd" },
  { key: "1Y", label: "1Y", name: "1 year", back: { months: 12 } },
  { key: "5Y", label: "5Y", name: "5 years", back: { months: 60 } },
  { key: "ALL", label: "All", name: "all history", back: null },
];

export const DEFAULT_RANGE = "6M";
export const rangeOf = (key) => RANGES.find((r) => r.key === key) ?? RANGES.find((r) => r.key === DEFAULT_RANGE);
export const intervalOf = (key) => INTERVALS.find((i) => i.key === key) ?? INTERVALS[2];

// Start of the period in ms (null for "All"). A month back from 31 March is
// the last day of February, not 3 March.
export function rangeStart(key, now = Date.now()) {
  const back = rangeOf(key).back;
  if (!back) return null;
  const d = new Date(now + MYT_MS);                     // MYT wall clock read with the UTC methods
  if (back === "ytd") return Date.UTC(d.getUTCFullYear(), 0, 1) - MYT_MS;
  if (back.days) return now - back.days * 86_400_000;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() - back.months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const t = Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  return t - MYT_MS;
}

// Candles of this size in the period (null for "All": not known in advance).
export function barsIn(rangeKey, intervalKey, now = Date.now()) {
  const start = rangeStart(rangeKey, now);
  return start === null ? null : Math.ceil((now - start) / intervalOf(intervalKey).ms);
}

// Can this candle size be used for this period? Not when it gives fewer than
// 2 candles, or more than the chart loads.
export function allowed(rangeKey, intervalKey, now = Date.now()) {
  const n = barsIn(rangeKey, intervalKey, now);
  if (n === null) return intervalKey === "1D" || intervalKey === "1W";
  return n >= 2 && n + WARMUP <= MAX_BARS;
}

export function whyNot(rangeKey, intervalKey, now = Date.now()) {
  if (allowed(rangeKey, intervalKey, now)) return "";
  const n = barsIn(rangeKey, intervalKey, now);
  return n !== null && n < 2 ? "Too few candles for this period" : "Too many candles for this period";
}

// The candle size picked when a period is chosen: the finest one that gives
// at most about 500 candles, so candles stay readable.
export function defaultInterval(rangeKey, now = Date.now()) {
  if (rangeOf(rangeKey).back === null) return "1W";
  const fits = INTERVALS.filter((i) => allowed(rangeKey, i.key, now));
  return (fits.find((i) => barsIn(rangeKey, i.key, now) <= 500) ?? fits.at(-1) ?? INTERVALS[2]).key;
}

// How many candles to ask the exchange for.
export function barsToLoad(rangeKey, intervalKey, now = Date.now()) {
  const n = barsIn(rangeKey, intervalKey, now);
  return n === null ? MAX_BARS : Math.min(n + WARMUP + 1, MAX_BARS);
}

// Price change over what is shown: from the open of the first candle in the
// period to the latest close.
export function periodChange(candles, start) {
  const shown = start === null ? candles : candles.filter((c) => (c.closeTime ?? c.time) > start);
  if (shown.length < 1) return null;
  const first = shown[0], last = shown.at(-1);
  return { from: first.time, to: last.closeTime ?? last.time, changePct: first.open ? ((last.close - first.open) / first.open) * 100 : null, bars: shown.length };
}

// ---------- free zooming (pinch / mouse wheel) ----------

export const ZOOM_IN_BARS = 20;       // fewer candles than this on screen while zooming in: smaller candles
// Zooming out: bigger candles once they are packed closer than 1.5 px (at
// least 150 on screen, so the next size never lands below ZOOM_IN_BARS).
export const zoomOutBars = (widthPx) => Math.max(150, Math.round(widthPx / 1.5));
export const MAX_LOADED = 10_000;     // most candles kept after loading older history

// The candle size to use after the user zoomed. `growing`: more candles are
// on screen than before (zooming out); `widthPx`: the chart's width. Smaller
// candles are only used when the history from `startMs` to now fits in one load.
export function nextInterval(key, visibleBars, growing, startMs, widthPx, now = Date.now()) {
  const i = INTERVALS.findIndex((x) => x.key === key);
  if (growing && visibleBars > zoomOutBars(widthPx) && i < INTERVALS.length - 1) return INTERVALS[i + 1].key;
  if (!growing && visibleBars < ZOOM_IN_BARS && i > 0) {
    const finer = INTERVALS[i - 1];
    if (Math.ceil((now - startMs) / finer.ms) + WARMUP <= MAX_BARS) return finer.key;
  }
  return key;
}

// Candles of this size needed to show from `startMs` up to now, with warm-up.
export const barsSince = (startMs, intervalKey, now = Date.now()) =>
  Math.ceil((now - startMs) / intervalOf(intervalKey).ms) + WARMUP + 1;

// Joins two candle lists (later ones win for the same time), oldest first.
export function mergeBars(a, b) {
  const m = new Map(a.map((c) => [c.time, c]));
  for (const c of b) m.set(c.time, c);
  return [...m.values()].sort((x, y) => x.time - y.time);
}

// Index of the last candle that starts at or before `t` (0 if none).
export function indexAt(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
