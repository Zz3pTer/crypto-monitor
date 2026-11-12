// Settings save format and help pop-up texts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { formatConfig } from "../js/github.js";
import { helpFor } from "../js/help-text.js";
import { evaluate } from "../js/signals.js";
import { validate } from "../js/config.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const cfg = read("./fixtures/config_base.json");

test("saved config text reads back as exactly the same settings", () => {
  const text = formatConfig(cfg);
  assert.deepEqual(JSON.parse(text), cfg);
  assert.deepEqual(validate(JSON.parse(text)), []);
});

test("saved config keeps one line per coin", () => {
  const lines = formatConfig(cfg).split("\n");
  for (const c of cfg.symbols) {
    const line = lines.filter((l) => l.includes(`"pair": "${c.pair}"`));
    assert.equal(line.length, 1);
    assert.match(line[0], new RegExp(`"symbol": "${c.symbol}".*"enabled"`));
  }
});

test("tricky text values survive saving", () => {
  const odd = structuredClone(cfg);
  odd.symbols[0].name = 'Bit, "coin": [x] {y}';
  odd.telegram.dashboard_url = "https://example.com/a,b?c=1&d=[2]";
  assert.deepEqual(JSON.parse(formatConfig(odd)), odd);
});

// Every "?" key used on the pages must have a text (FR-HELP-01).
const KEYS = ["Signal score", "RSI", "MACD", "SMA 200", "SMA 50", "EMA 20", "Bollinger",
  "Trend (price vs SMA 200)", "Trend structure (SMA 50 vs SMA 200)", "Momentum ROC", "Volume ratio"];

const raw = read("./fixtures/parity_candles.json").assets.BTC;
const candles = raw.map((r) => ({ open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));
const res = evaluate(candles, cfg.signal, "HOLD");

for (const key of KEYS) {
  test(`help text for "${key}" is complete and has a "Now" value`, () => {
    const h = helpFor(key, cfg);
    assert.ok(h, "missing entry");
    assert.ok(h.short && h.full && h.what && h.ranges.length >= 2);
    const now = h.now(res, res.close);
    assert.match(now, /—/);
    assert.doesNotMatch(now, /undefined|NaN/);
  });
}

test("help numbers follow the configuration", () => {
  const c = structuredClone(cfg);
  c.signal.rsi_oversold = 25;
  c.signal.thresholds.buy = 40;
  assert.match(helpFor("RSI", c).ranges[0][1], /Below 25/);
  assert.match(helpFor("Signal score", c).ranges[0][1], /\+40 or more/);
});

test("every help key used in the page code exists", () => {
  const src = ["ui-overview.js", "ui-detail.js", "charts.js"].map((f) => readFileSync(new URL(`../js/${f}`, import.meta.url), "utf8")).join("\n");
  const used = new Set([...src.matchAll(/help\("([^"]+)"/g)].map((m) => m[1]));
  for (const m of src.matchAll(/help: "([^"]+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/\[`[^`]*`, "([^"]+)", /g)) used.add(m[1]);
  for (const k of used) assert.ok(helpFor(k, cfg), `no help text for "${k}"`);
  assert.ok(used.size >= 8, `only found ${used.size} help keys`);
});
