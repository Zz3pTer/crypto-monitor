// The website's config check must refuse exactly what the Python one refuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validate, enabledSymbols } from "../js/config.js";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const base = read("../config/config.json");
const { cases } = read("./fixtures/config_cases.json");

function applyCase(cfg, c) {
  const parents = c.path.slice(0, -1), last = c.path.at(-1);
  let node = cfg;
  for (const k of parents) node = node[k];
  if (c.op === "set") node[last] = structuredClone(c.value);
  else if (c.op === "append") node[last].push(structuredClone(c.value));
  else if (c.op === "delete") delete node[last];
}

test("repo config is valid", () => assert.deepEqual(validate(base), []));

test("starting coin list", () => {
  assert.deepEqual(enabledSymbols(base).map((s) => s.symbol), ["BTC", "ETH", "SOL", "ADA", "XLM", "XRP", "ALGO", "HBAR", "LINK"]);
});

for (const c of cases) {
  test(`bad config is reported: ${c.expect}`, () => {
    const cfg = structuredClone(base);
    applyCase(cfg, c);
    const problems = validate(cfg);
    assert.ok(problems.some((p) => p.includes(c.expect)), problems.join(" | "));
  });
}
