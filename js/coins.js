// Adding and removing coins.
//   Shared coins:  in config/config.json, so on the dashboard for everyone and
//                  in the Telegram report. Changing them needs a GitHub token.
//   My view only:  kept in this browser (localStorage "extraCoins"); shown on
//                  this dashboard with live prices and signals, never in the report.
import * as store from "./store.js";
import * as gh from "./github.js";
import { validate, MAX_COINS } from "./config.js";

const EXTRA_KEY = "extraCoins";
const PENDING_KEY = "pendingConfig";
const PENDING_MAX_MS = 10 * 60_000;

export const extraCoins = () => {
  const v = store.get(EXTRA_KEY, []);
  return Array.isArray(v) ? v.filter((c) => c && c.symbol && c.pair) : [];
};

// Every coin this browser shows: the shared enabled coins, then the browser-only ones.
export function viewCoins(cfg) {
  const shared = cfg.symbols.filter((c) => c.enabled !== false);
  const known = new Set(cfg.symbols.map((c) => c.symbol));
  return [...shared, ...extraCoins().filter((c) => !known.has(c.symbol)).map((c) => ({ ...c, local: true }))];
}

export function status(cfg, symbol) {
  const s = cfg.symbols.find((c) => c.symbol === symbol);
  if (s) return s.enabled === false ? "off" : "shared";
  return extraCoins().some((c) => c.symbol === symbol) ? "local" : null;
}

export const roomLeft = (cfg) => MAX_COINS - viewCoins(cfg).length;

export function addLocal(coin) {
  store.set(EXTRA_KEY, [...extraCoins().filter((c) => c.symbol !== coin.symbol), { symbol: coin.symbol, name: coin.name, pair: coin.pair }]);
}

export function removeLocal(symbol) {
  store.set(EXTRA_KEY, extraCoins().filter((c) => c.symbol !== symbol));
}

// ---------- shared list (config.json) ----------

// Pure changes to a config, used on the copy just read from GitHub.
export function withCoin(cfg, coin) {
  const out = structuredClone(cfg);
  const i = out.symbols.findIndex((c) => c.symbol === coin.symbol);
  if (i >= 0) out.symbols[i].enabled = true;           // switched off before: switch it back on
  else out.symbols.push({ symbol: coin.symbol, name: coin.name, pair: coin.pair, coingecko_id: coin.coingecko_id ?? "", enabled: true });
  return out;
}

export function withoutCoin(cfg, symbol) {
  const out = structuredClone(cfg);
  out.symbols = out.symbols.filter((c) => c.symbol !== symbol);
  out.alerts.targets = (out.alerts.targets ?? []).filter((t) => t.symbol !== symbol);
  return out;
}

// Reads config.json from GitHub, applies `change`, checks it and saves it as
// one commit. Working on the latest copy means someone else's change made in
// the meantime is kept, not overwritten.
export async function changeShared(cfg, token, change, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const remote = await gh.readRemote(cfg, token);
    const next = change(JSON.parse(remote.text));
    const problems = validate(next);
    if (problems.length) throw new Error(problems.join("; "));
    try {
      const res = await gh.saveConfig(cfg, token, gh.formatConfig(next) + "\n", remote.sha, message);
      rememberSaved(next);
      return { cfg: next, commitUrl: res.commitUrl };
    } catch (e) {
      if (e.status !== 409) throw e;
      if (attempt) throw new Error("Someone else saved the shared settings at the same moment. Please try again.");
      // saved by someone else at that moment: read again
    }
  }
}

// GitHub Pages takes about a minute to publish a saved config. Until it does,
// this browser keeps using the copy it saved, so the change shows at once.
export function rememberSaved(cfg) {
  store.set(PENDING_KEY, { cfg, at: Date.now() });
}

export function pendingConfig(published) {
  const p = store.get(PENDING_KEY, null);
  if (!p?.cfg || Date.now() - p.at > PENDING_MAX_MS || JSON.stringify(p.cfg) === JSON.stringify(published) || validate(p.cfg).length) {
    if (p) store.set(PENDING_KEY, null);
    return null;
  }
  return p.cfg;
}
