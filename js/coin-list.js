// Every coin that can be added: all Binance spot pairs against the quote coin
// (USDT) that are trading now. Names come from Binance's product list, or from
// the saved copy data/coin-names.json when that list cannot be reached.
// Loaded once per page, when the coin search is first opened.

const PRODUCTS = "https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=false";

async function getJson(url, timeoutMs = 10_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Builds the list from the raw answers. Pure, so it can be tested.
//   info:    /api/v3/exchangeInfo   tickers: /api/v3/ticker/24hr (all pairs)
//   names:   { BASE: "Full name" }
export function buildList(info, tickers, names, quote = "USDT") {
  const tick = new Map((tickers ?? []).map((t) => [t.symbol, t]));
  return (info?.symbols ?? [])
    .filter((s) => s.quoteAsset === quote && s.status === "TRADING" && s.isSpotTradingAllowed !== false)
    .map((s) => {
      const t = tick.get(s.symbol);
      const last = t ? +t.lastPrice : null;
      const open = t ? +t.openPrice : null;
      return {
        symbol: s.baseAsset,
        pair: s.symbol,
        name: names?.[s.baseAsset] || s.baseAsset,
        price: last,
        changePct: last != null && open ? ((last - open) / open) * 100 : null,
        quoteVolume: t ? +t.quoteVolume : 0,
      };
    })
    .sort((a, b) => b.quoteVolume - a.quoteVolume);
}

let cache = null;

export async function loadCoinList(cfg) {
  if (cache) return cache;
  const rest = cfg.data.providers.binance.rest;
  const quote = cfg.data.quote ?? "USDT";
  const [info, tickers, live, saved] = await Promise.all([
    getJson(`${rest}/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING&showPermissionSets=false`),
    getJson(`${rest}/api/v3/ticker/24hr?type=MINI`).catch(() => []),
    getJson(PRODUCTS, 6000).catch(() => null),
    getJson(`data/coin-names.json?t=${Date.now()}`).catch(() => ({})),
  ]);
  const names = { ...saved };
  for (const r of live?.data ?? []) if (r.q === quote && r.an) names[r.b] = r.an;
  for (const c of cfg.symbols) names[c.symbol] = c.name;
  cache = buildList(info, tickers, names, quote);
  return cache;
}

// Best matches first: exact symbol, then symbol or name starting with the
// text, then containing it. Ties go to the most traded coin.
export function search(list, query, limit = 20) {
  const q = query.trim().toUpperCase();
  if (!q) return list.slice(0, limit);
  const rank = (c) => {
    const sym = c.symbol.toUpperCase(), name = c.name.toUpperCase();
    if (sym === q) return 0;
    if (name === q) return 1;
    if (sym.startsWith(q)) return 2;
    if (name.startsWith(q) || name.split(/[\s().*-]+/).some((w) => w.startsWith(q))) return 3;
    if (sym.includes(q) || name.includes(q)) return 4;
    return -1;
  };
  return list
    .map((c, i) => ({ c, r: rank(c), i }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
