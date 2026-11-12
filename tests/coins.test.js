// Coin search and adding/removing coins (shared list and "my view only").
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A small in-memory localStorage for store.js.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { buildList, search } = await import("../js/coin-list.js");
const coins = await import("../js/coins.js");
const { validate, MAX_COINS } = await import("../js/config.js");

const cfg = JSON.parse(readFileSync(new URL("../config/config.json", import.meta.url), "utf8"));
beforeEach(() => mem.clear());

const pairOf = (b, q = "USDT", status = "TRADING") => ({ symbol: b + q, baseAsset: b, quoteAsset: q, status, isSpotTradingAllowed: true });
const info = { symbols: [pairOf("BTC"), pairOf("DOGE"), pairOf("HBAR"), pairOf("DOGE", "BTC"), pairOf("OLD", "USDT", "BREAK"), pairOf("1000SATS")] };
const tickers = [
  { symbol: "BTCUSDT", lastPrice: "110", openPrice: "100", quoteVolume: "9000" },
  { symbol: "DOGEUSDT", lastPrice: "0.2", openPrice: "0.25", quoteVolume: "500" },
  { symbol: "HBARUSDT", lastPrice: "0.3", openPrice: "0.3", quoteVolume: "100" },
];
const names = { BTC: "Bitcoin", DOGE: "Dogecoin", HBAR: "Hedera Hashgraph", "1000SATS": "1000*SATS (Ordinals)" };
const list = buildList(info, tickers, names);

test("coin list: only trading USDT pairs, most traded first, with names and 24h change", () => {
  assert.deepEqual(list.map((c) => c.pair), ["BTCUSDT", "DOGEUSDT", "HBARUSDT", "1000SATSUSDT"]);
  assert.equal(list[0].name, "Bitcoin");
  assert.equal(list[0].changePct, 10);
  assert.ok(Math.abs(list[1].changePct + 20) < 1e-9);
  assert.equal(list[3].price, null);
  assert.equal(buildList(info, [], {})[1].name, "DOGE");          // no names: the symbol stands in
});

test("search by symbol or name, best match first", () => {
  assert.equal(search(list, "doge")[0].symbol, "DOGE");
  assert.equal(search(list, "Dogecoin")[0].symbol, "DOGE");
  assert.equal(search(list, "hedera")[0].symbol, "HBAR");
  assert.equal(search(list, "hash")[0].symbol, "HBAR");            // any word of the name
  assert.equal(search(list, "sats")[0].symbol, "1000SATS");
  assert.equal(search(list, "  btc ")[0].symbol, "BTC");
  assert.deepEqual(search(list, "zzzz"), []);
  assert.equal(search(list, "").length, 4);
  assert.equal(search(list, "", 2).length, 2);
});

test("an exact symbol beats a longer one", () => {
  const l = buildList({ symbols: ["ARB", "AR", "ARK"].map((b) => pairOf(b)) },
    [{ symbol: "ARBUSDT", lastPrice: "1", openPrice: "1", quoteVolume: "100" }], {});
  assert.equal(search(l, "ar")[0].symbol, "AR");
});

const doge = { symbol: "DOGE", name: "Dogecoin", pair: "DOGEUSDT" };

test("adding a coin to the shared list gives a valid config", () => {
  const next = coins.withCoin(cfg, doge);
  assert.deepEqual(validate(next), []);
  assert.deepEqual(next.symbols.at(-1), { ...doge, coingecko_id: "", enabled: true });
  assert.equal(cfg.symbols.some((c) => c.symbol === "DOGE"), false);   // the original is untouched
});

test("adding a switched-off coin switches it back on", () => {
  const off = structuredClone(cfg);
  off.symbols[2].enabled = false;
  const next = coins.withCoin(off, { symbol: off.symbols[2].symbol, name: "x", pair: "x" });
  assert.equal(next.symbols.length, cfg.symbols.length);
  assert.equal(next.symbols[2].enabled, true);
  assert.equal(next.symbols[2].name, cfg.symbols[2].name);
});

test("removing a shared coin also removes its price targets", () => {
  const next = coins.withoutCoin(cfg, "BTC");
  assert.equal(next.symbols.some((c) => c.symbol === "BTC"), false);
  assert.equal(next.alerts.targets.some((t) => t.symbol === "BTC"), false);
  assert.deepEqual(validate(next), []);
});

test(`more than ${MAX_COINS} shared coins is refused`, () => {
  let c = cfg;
  for (let i = c.symbols.length; i < MAX_COINS; i++) c = coins.withCoin(c, { symbol: `X${i}`, name: `X${i}`, pair: `X${i}USDT` });
  assert.deepEqual(validate(c), []);
  assert.match(validate(coins.withCoin(c, doge)).join(), /maximum is 30/);
});

test("my-view coins come after the shared ones and never twice", () => {
  coins.addLocal(doge);
  coins.addLocal(doge);
  coins.addLocal({ symbol: "BTC", name: "Bitcoin", pair: "BTCUSDT" });   // already shared: not shown twice
  const view = coins.viewCoins(cfg);
  assert.equal(view.length, cfg.symbols.length + 1);
  assert.deepEqual(view.at(-1), { ...doge, local: true });
  assert.equal(coins.status(cfg, "DOGE"), "local");
  assert.equal(coins.status(cfg, "BTC"), "shared");
  assert.equal(coins.status(cfg, "PEPE"), null);
  assert.equal(coins.roomLeft(cfg), MAX_COINS - cfg.symbols.length - 1);
  coins.removeLocal("DOGE");
  assert.equal(coins.status(cfg, "DOGE"), null);
});

test("a just-saved config is used until GitHub Pages publishes it", () => {
  const saved = coins.withCoin(cfg, doge);
  assert.equal(coins.pendingConfig(cfg), null);
  coins.rememberSaved(saved);
  assert.deepEqual(coins.pendingConfig(cfg), saved);                  // the site still serves the old one
  assert.equal(coins.pendingConfig(saved), null);                     // published: forget the copy
  assert.equal(coins.pendingConfig(cfg), null);
  mem.set("csm.pendingConfig", JSON.stringify({ cfg: saved, at: Date.now() - 11 * 60_000 }));
  assert.equal(coins.pendingConfig(cfg), null);                       // too old
});

test("changing the shared list works on the latest copy from GitHub", async () => {
  const remoteCfg = coins.withCoin(cfg, { symbol: "PEPE", name: "Pepe", pair: "PEPEUSDT" });   // someone else's change
  const puts = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (!opts.method) return new Response(JSON.stringify({ sha: "abc", content: Buffer.from(JSON.stringify(remoteCfg)).toString("base64") }), { status: 200 });
    puts.push(JSON.parse(opts.body));
    return new Response(JSON.stringify({ content: { sha: "def" }, commit: { html_url: "https://github.com/x" } }), { status: 200 });
  };
  const res = await coins.changeShared(cfg, "token", (c) => coins.withCoin(c, doge), "Add DOGE");
  const saved = JSON.parse(Buffer.from(puts[0].content, "base64").toString());
  assert.deepEqual(saved.symbols.map((c) => c.symbol).slice(-2), ["PEPE", "DOGE"]);   // both kept
  assert.equal(puts[0].sha, "abc");
  assert.deepEqual(res.cfg, saved);
  assert.deepEqual(coins.pendingConfig(cfg), saved);
});

test("a change that breaks the config is not saved", async () => {
  let put = false;
  globalThis.fetch = async (url, opts = {}) => {
    if (opts.method) { put = true; return new Response("{}", { status: 200 }); }
    return new Response(JSON.stringify({ sha: "abc", content: Buffer.from(JSON.stringify(cfg)).toString("base64") }), { status: 200 });
  };
  await assert.rejects(coins.changeShared(cfg, "t", (c) => coins.withCoin(c, { symbol: "BTC2", name: "", pair: "X" }), "x"), /needs a text "name"/);
  assert.equal(put, false);
});
