// FR-SIG-05: the JavaScript engine must give the same votes and signals as
// Python on the shared test file (tests/fixtures, built by make_fixtures.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeIndicators, evaluate, evaluateSeries } from "../js/signals.js";

const read = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const expected = read("expected.json");
const raw = read("parity_candles.json").assets;
const sig = expected.signal_config;
const toCandles = (rows) => rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }));

for (const symbol of Object.keys(raw).sort()) {
  const exp = expected.assets[symbol];
  const candles = toCandles(raw[symbol]);

  test(`${symbol}: every indicator value is identical`, () => {
    const mine = computeIndicators(candles, sig);
    for (const [k, values] of Object.entries(exp.indicators)) {
      assert.deepEqual(mine[k], values, `indicator ${k}`);
    }
  });

  test(`${symbol}: daily votes, scores and signals are identical`, () => {
    const mine = evaluateSeries(candles, sig).map((d) => d && { score: d.score, signal: d.signal, strong: d.strong, votes: d.votes });
    assert.deepEqual(mine, exp.series);
  });

  test(`${symbol}: latest evaluation is identical`, () => {
    const prev = exp.series.at(-2)?.signal ?? null;
    assert.deepEqual(evaluate(candles, sig, prev), exp.last);
  });
}
