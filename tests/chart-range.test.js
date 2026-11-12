// Chart period buttons on the detail screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../js/chart-range.js";

const myt = (s) => Date.parse(`${s}+08:00`);
const now = myt("2026-11-12T16:30:00");
const day = (t) => new Date(t + R.MYT_MS).toISOString().slice(0, 10);

test("periods end now and start on the same date back in MYT", () => {
  assert.equal(day(R.rangeStart("1Y", now)), "2025-11-12");
  assert.equal(day(R.rangeStart("6M", now)), "2026-05-12");
  assert.equal(day(R.rangeStart("1M", now)), "2026-10-12");
  assert.equal(day(R.rangeStart("5Y", now)), "2021-11-12");
  assert.equal(R.rangeStart("1D", now), now - 86_400_000);
  assert.equal(R.rangeStart("YTD", now), myt("2026-01-01T00:00:00"));
  assert.equal(R.rangeStart("ALL", now), null);
});

test("a month back from 31 March is the end of February", () => {
  assert.equal(day(R.rangeStart("1M", myt("2026-03-31T12:00:00"))), "2026-02-28");
  assert.equal(day(R.rangeStart("1Y", myt("2028-02-29T12:00:00"))), "2027-02-28");
});

test("each period gets readable candles by default", () => {
  const picks = Object.fromEntries(R.RANGES.map((r) => [r.key, R.defaultInterval(r.key, now)]));
  assert.deepEqual(picks, { "1D": "1H", "1W": "1H", "1M": "4H", "3M": "1D", "6M": "1D", YTD: "1D", "1Y": "1D", "5Y": "1W", ALL: "1W" });
  for (const r of R.RANGES) assert.ok(R.allowed(r.key, picks[r.key], now));
});

test("candle sizes that give too few or too many candles are refused", () => {
  assert.equal(R.allowed("1D", "1D", now), false);                  // 1 candle
  assert.match(R.whyNot("1D", "1D", now), /few/);
  assert.equal(R.allowed("1Y", "1H", now), false);                  // 8760 candles
  assert.match(R.whyNot("1Y", "1H", now), /many/);
  assert.equal(R.allowed("1Y", "4H", now), true);
  assert.equal(R.allowed("5Y", "1D", now), true);
  assert.equal(R.allowed("ALL", "4H", now), false);
  assert.equal(R.whyNot("6M", "1D", now), "");
});

test("enough candles are loaded for the period plus the indicator warm-up", () => {
  assert.equal(R.barsIn("1Y", "1D", now), 365);
  assert.equal(R.barsToLoad("1Y", "1D", now), 365 + R.WARMUP + 1);
  assert.equal(R.barsToLoad("ALL", "1D", now), R.MAX_BARS);
  assert.ok(R.barsToLoad("5Y", "1D", now) <= R.MAX_BARS);
});

test("change over the period runs from the first candle in it to the latest close", () => {
  const D = 86_400_000, t0 = myt("2026-11-01T08:00:00");
  const c = [0, 1, 2, 3].map((i) => ({ time: t0 + i * D, closeTime: t0 + (i + 1) * D - 1, open: 100 + i * 10, close: 105 + i * 10 }));
  const p = R.periodChange(c, t0 + 1.5 * D);                         // starts inside the second candle
  assert.equal(p.bars, 3);
  assert.equal(p.from, c[1].time);
  assert.equal(p.changePct, (135 - 110) / 110 * 100);
  assert.equal(R.periodChange(c, null).bars, 4);
  assert.equal(R.periodChange([], null), null);
});

test("unknown saved choices fall back to safe ones", () => {
  assert.equal(R.rangeOf("10Y").key, R.DEFAULT_RANGE);
  assert.equal(R.intervalOf("15m").key, "1D");
});

test("long periods are fetched from Binance in parts", async () => {
  const { Feed } = await import("../js/data-source.js");
  const cfg = { data: { providers: { binance: { rest: "https://x", ws: "wss://x" } } }, refresh: {} };
  const feed = new Feed(cfg, []);
  const first = 1_000_000, H = 3_600_000, total = 2500;      // a coin with 2500 candles
  const asks = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url), limit = +u.searchParams.get("limit"), end = u.searchParams.get("endTime");
    asks.push(limit);
    const lastIdx = end ? Math.floor((+end - first) / H) : total - 1;
    const rows = [];
    for (let i = Math.max(0, lastIdx - limit + 1); i <= lastIdx; i++) rows.push([first + i * H, "1", "1", "1", "1", "1", first + (i + 1) * H - 1]);
    return new Response(JSON.stringify(rows));
  };
  const all = await feed.klines("XUSDT", "1h", 4000);
  assert.equal(all.length, total);                                   // stops at the coin's first candle
  assert.equal(asks.length, 3);
  assert.ok(all.every((k, i) => !i || k.time - all[i - 1].time === H));   // in order, nothing twice
  asks.length = 0;
  assert.equal((await feed.klines("XUSDT", "1h", 1200)).length, 1200);
  assert.deepEqual(asks, [1000, 200]);
  asks.length = 0;
  assert.equal((await feed.klines("XUSDT", "1h", 300)).length, 300);
  assert.deepEqual(asks, [300]);
});

test("zooming far out switches to bigger candles, zooming far in to smaller ones", () => {
  const yearAgo = now - 365 * 86_400_000, weekAgo = now - 7 * 86_400_000;
  const desk = 1100, phone = 290;                                     // chart widths in px
  assert.equal(R.zoomOutBars(desk), 733);
  assert.equal(R.zoomOutBars(phone), 193);
  assert.equal(R.nextInterval("1D", 750, true, yearAgo, desk, now), "1W");
  assert.equal(R.nextInterval("1D", 200, true, yearAgo, phone, now), "1W");   // a phone switches sooner
  assert.equal(R.nextInterval("1D", 200, true, yearAgo, desk, now), "1D");
  assert.equal(R.nextInterval("1D", 750, false, yearAgo, desk, now), "1D");   // only while zooming out
  assert.equal(R.nextInterval("1W", 900, true, yearAgo, desk, now), "1W");    // no bigger size
  assert.equal(R.nextInterval("1D", 15, false, weekAgo, desk, now), "4H");
  assert.equal(R.nextInterval("1H", 10, false, weekAgo, desk, now), "1H");    // no smaller size
  // zoomed in on 2019: hourly candles from then to now would be far too many
  assert.equal(R.nextInterval("4H", 15, false, now - 7 * 365 * 86_400_000, desk, now), "4H");
  // a switch never flips straight back: the new count lands between the limits
  for (const w of [phone, desk, 2000]) {
    for (const [a, b] of [["1H", "4H"], ["4H", "1D"], ["1D", "1W"]]) {
      const ratio = R.intervalOf(b).ms / R.intervalOf(a).ms;
      assert.ok((R.zoomOutBars(w) + 1) / ratio > R.ZOOM_IN_BARS, `${a}->${b} at ${w}px`);
      assert.ok(R.ZOOM_IN_BARS * ratio < R.zoomOutBars(w), `${b}->${a} at ${w}px`);
    }
  }
});

test("older candles are joined to the loaded ones in order, nothing twice", () => {
  const c = (t, close = 1) => ({ time: t, close });
  const m = R.mergeBars([c(1), c(2), c(3)], [c(3, 9), c(4)]);
  assert.deepEqual(m.map((x) => x.time), [1, 2, 3, 4]);
  assert.equal(m[2].close, 9);
  assert.equal(R.indexAt(m, 2.5), 1);
  assert.equal(R.indexAt(m, 0), 0);
  assert.equal(R.indexAt(m, 99), 3);
  assert.equal(R.barsSince(now - 10 * 86_400_000, "1D", now), 10 + R.WARMUP + 1);
});
