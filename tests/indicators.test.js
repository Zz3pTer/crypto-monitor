// Small hand-checked cases, mirroring tests/test_indicators.py.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as ind from "../js/indicators.js";
import { classify } from "../js/signals.js";
import { readFileSync } from "node:fs";

const sig = JSON.parse(readFileSync(new URL("../config/config.json", import.meta.url), "utf8")).signal;

test("sma", () => assert.deepEqual(ind.sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]));
test("ema seeded with sma", () => assert.deepEqual(ind.ema([2, 4, 6, 8], 3), [null, null, 4, 6]));
test("ema skips leading nulls", () => assert.deepEqual(ind.ema([null, null, 2, 4, 6, 8], 3), [null, null, null, null, 4, 6]));
test("rsi extremes", () => {
  assert.equal(ind.rsi(Array.from({ length: 29 }, (_, i) => i + 1), 14).at(-1), 100);
  assert.equal(ind.rsi(Array.from({ length: 29 }, (_, i) => 30 - i), 14).at(-1), 0);
  assert.equal(ind.rsi(new Array(30).fill(5), 14).at(-1), 50);
});
test("bollinger flat prices", () => {
  const [u, m, l] = ind.bollinger(new Array(25).fill(10), 20, 2);
  assert.equal(u.at(-1), 10); assert.equal(m.at(-1), 10); assert.equal(l.at(-1), 10);
});
test("roc", () => assert.ok(Math.abs(ind.roc([100, 101, 102, 110], 3)[3] - 10) < 1e-12));
test("volume ratio", () => assert.ok(Math.abs(ind.volumeRatio([...new Array(19).fill(100), 300], 20).at(-1) - 300 / 110) < 1e-12));

const cases = [
  [65, null, "BUY", true], [64, null, "BUY", false], [35, null, "BUY", false], [34, null, "HOLD", false],
  [-35, null, "SELL", false], [-65, null, "SELL", true],
  [30, "BUY", "BUY", false], [29, "BUY", "HOLD", false], [-30, "SELL", "SELL", false], [-29, "SELL", "HOLD", false],
  [34, "HOLD", "HOLD", false], [-40, "BUY", "SELL", false],
];
for (const [score, prev, signal, strong] of cases) {
  test(`classify ${score} after ${prev}`, () => assert.deepEqual(classify(score, prev, sig), [signal, strong]));
}
