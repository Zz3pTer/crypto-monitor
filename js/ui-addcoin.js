// Coin search: find any coin on Binance, look at it, then add it for everyone
// (dashboard + Telegram report; needs a GitHub token) or to this browser's
// view only. Opened for a coin already on the dashboard, it offers removing it.
import * as fmt from "./format.js";
import * as gh from "./github.js";
import * as coins from "./coins.js";
import { loadCoinList, search } from "./coin-list.js";
import { evaluate } from "./signals.js";
import { runAsset, settings as btSettings, daysNeeded } from "./backtest.js";
import { sparkline } from "./ui-overview.js";
import { MAX_COINS } from "./config.js";

const esc = fmt.escape;
const DAY_MS = 86_400_000;
let el = null, lastFocus = null, S = null, searchTimer = null;

export function open(app, symbol = null) {
  // app: { cfg, feed, overrideActive }
  lastFocus = document.activeElement;
  S = { app, list: null, listError: null, query: "", results: [], sel: null, preview: null, busy: false,
        message: null, token: gh.getToken(), who: null };
  if (!el) build();
  el.hidden = false;
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => el.classList.add("open"));
  render();
  if (symbol) select(symbol); else el.querySelector("#coin-q").focus();
  if (S.token) gh.checkToken(app.cfg, S.token).then((w) => { S.who = w; renderActions(); }).catch(() => { S.who = { ok: false, reason: "Could not check the GitHub token." }; renderActions(); });
  loadCoinList(app.cfg)
    .then((list) => { S.list = list; S.results = search(list, S.query); renderResults(); if (S.sel && !S.sel.coin.name) select(S.sel.symbol); })
    .catch((e) => { S.listError = `Could not load the coin list from Binance (${e.message}).`; renderResults(); });
}

export function close() {
  if (!el || el.hidden || S?.busy) return;
  el.classList.remove("open");
  document.body.classList.remove("no-scroll");
  setTimeout(() => { el.hidden = true; }, 200);
  lastFocus?.focus?.();
}

function build() {
  el = document.createElement("div");
  el.className = "set-wrap coin-wrap";
  el.hidden = true;
  el.innerHTML = `<div class="set-backdrop"></div>
    <aside class="set-panel" role="dialog" aria-modal="true" aria-labelledby="coin-title">
      <header class="set-head"><h2 id="coin-title">Add a coin</h2><button class="btn set-close" aria-label="Close">✕</button></header>
      <div class="set-body">
        <input class="btn wide" id="coin-q" type="search" placeholder="Search by name or symbol, e.g. Dogecoin or DOGE" aria-label="Search coins" autocomplete="off">
        <div id="coin-results" class="coin-results" role="listbox" aria-label="Coins"></div>
        <div id="coin-preview"></div>
      </div>
    </aside>`;
  document.body.append(el);
  el.querySelector(".set-backdrop").addEventListener("click", close);
  el.querySelector(".set-close").addEventListener("click", close);
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } });
  el.querySelector("#coin-q").addEventListener("input", (e) => {
    S.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (S.list) { S.results = search(S.list, S.query); renderResults(); } }, 120);
  });
  el.addEventListener("click", onClick);
}

// ---------- rendering ----------

function render() {
  el.querySelector("#coin-q").value = S.query;
  renderResults();
  renderPreview();
}

function badge(sym) {
  const st = coins.status(S.app.cfg, sym);
  return st === "shared" ? `<span class="tag on">On dashboard</span>` : st === "local" ? `<span class="tag">My view</span>` : st === "off" ? `<span class="tag">Switched off</span>` : "";
}

function renderResults() {
  const box = el.querySelector("#coin-results");
  if (S.listError) { box.innerHTML = `<p class="err">${esc(S.listError)}</p>`; return; }
  if (!S.list) { box.innerHTML = `<p class="muted">Loading the coin list…</p>`; return; }
  const head = S.query.trim() ? "" : `<p class="muted">${S.list.length} coins on Binance. Most traded first:</p>`;
  box.innerHTML = head + (S.results.length ? S.results.map((c) => `
    <button class="coin-row${S.sel?.symbol === c.symbol ? " sel" : ""}" role="option" aria-selected="${S.sel?.symbol === c.symbol}" data-pick="${esc(c.symbol)}">
      <b>${esc(c.symbol)}</b><span class="name">${esc(c.name)}</span>${badge(c.symbol)}
      <span class="num">${fmt.price(c.price)}</span>
      <span class="num ${c.changePct >= 0 ? "up" : "down"}">${c.changePct == null ? "" : fmt.pct(c.changePct)}</span>
    </button>`).join("") : `<p class="muted">No coin on Binance matches “${esc(S.query.trim())}”.</p>`);
}

function renderPreview() {
  const box = el.querySelector("#coin-preview");
  if (!S.sel) { box.innerHTML = ""; return; }
  const c = S.sel.coin, p = S.preview;
  const info = !p ? `<p class="muted">Loading ${esc(c.symbol)}…</p>`
    : p.error ? `<p class="err">${esc(p.error)}</p>`
    : previewBody(c, p);
  box.innerHTML = `<section class="coin-preview panel">
      <div class="cp-head"><h3>${esc(c.symbol)} <span class="name">${esc(c.name ?? "")}</span></h3><span class="muted">${esc(c.pair)}</span></div>
      ${info}
      <div id="coin-actions"></div>
    </section>`;
  renderActions();
}

function previewBody(c, p) {
  const t = p.ticker;
  const sig = p.signal;
  const signalLine = sig?.status === "ok"
    ? `<span class="badge ${sig.signal}${sig.strong ? " strong" : ""}">${sig.strong ? "STRONG " : ""}${sig.signal}</span> score <b class="num">${fmt.signed(sig.score)}</b> <span class="muted">(provisional, from today's open candle)</span>`
    : `<span class="muted">Not enough history for a signal yet (${p.days} of ${S.app.cfg.signal.min_candles} days needed).</span>`;
  const bt = p.backtest;
  const btLine = bt?.status === "ok"
    ? `Backtest ${esc(bt.period)}: BUY right after ${bt.horizons[0]?.days} days ${rate(bt.horizons[0]?.buy_hit_rate)}, following the signals ${fmt.pct(bt.strategy_return_pct)} vs holding ${fmt.pct(bt.buy_hold_return_pct)}.`
    : "No backtest yet: not enough history.";
  return `<div class="cp-price"><span class="price num">${fmt.price(t?.last ?? p.last)}</span>
      ${t ? `<span class="change num ${t.changePct >= 0 ? "up" : "down"}">${t.changePct >= 0 ? "▲" : "▼"} ${fmt.pct(t.changePct)} <span class="muted">24h</span></span>` : ""}</div>
    ${sparkline(p.hourly)}
    <dl class="cp-facts">
      <dt>24h volume</dt><dd class="num">${t ? `$${Math.round(t.quoteVolume).toLocaleString("en-US")}` : "—"}</dd>
      <dt>History</dt><dd>${p.full ? `${Math.floor(p.days / 365)}+ years of daily candles` : `${p.days} days (listed ${fmt.date(p.firstTime)})`}</dd>
      <dt>Signal now</dt><dd>${signalLine}</dd>
    </dl>
    <p class="muted">${btLine} Past results do not predict future results.</p>`;
}

const rate = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

function renderActions() {
  const box = el?.querySelector("#coin-actions");
  if (!box || !S.sel) return;
  const sym = S.sel.symbol, st = coins.status(S.app.cfg, sym);
  const room = coins.roomLeft(S.app.cfg) > 0;
  const tokenOk = Boolean(S.token && S.who?.ok);
  const sharedBlock = S.app.overrideActive
    ? "This browser is trying settings that are not saved. Go back to the saved settings first."
    : !S.token ? "Changing the list for everyone needs a GitHub token (Settings → Shared settings)."
    : S.who && !S.who.ok ? S.who.reason
    : !S.who ? "Checking your GitHub token…" : null;
  const btn = (act, label, enabled, cls = "") => `<button class="btn ${cls}" data-act="${act}" ${enabled && !S.busy ? "" : "disabled"}>${label}</button>`;
  let html = "";
  if (st === null) {
    html = `${btn("add-shared", "Add for everyone", tokenOk && room && !sharedBlock, "primary")} ${btn("add-local", "Add to my view only", room)}
      <p class="muted">For everyone: on the dashboard and in the daily Telegram report. My view only: on this browser's dashboard, not in the report.</p>`;
  } else if (st === "local") {
    html = `<p>In your view only (not in the Telegram report).</p>${btn("add-shared", "Add for everyone", tokenOk && !sharedBlock, "primary")} ${btn("remove-local", "Remove from my view", true)} ${btn("open", "Open", true)}`;
  } else if (st === "off") {
    html = `<p>In the shared list but switched off.</p>${btn("add-shared", "Switch on for everyone", tokenOk && room && !sharedBlock, "primary")}`;
  } else {
    html = `<p>On the dashboard for everyone and in the daily report.</p>${btn("remove-shared", "Remove for everyone", tokenOk && !sharedBlock, "danger")} ${btn("open", "Open", true)}`;
  }
  if (!room && (st === null || st === "off")) html += `<p class="err">${MAX_COINS} coins is the most the dashboard shows. Remove one first.</p>`;
  if (sharedBlock && (st !== "local" || S.token)) html += `<p class="muted">${esc(sharedBlock)}</p>`;
  if (S.message) html += `<div class="set-msg ${S.message.kind}">${S.message.html}</div>`;
  box.innerHTML = html;
}

// ---------- actions ----------

async function select(symbol) {
  const fromList = S.list?.find((c) => c.symbol === symbol);
  const known = coins.viewCoins(S.app.cfg).find((c) => c.symbol === symbol) ?? S.app.cfg.symbols.find((c) => c.symbol === symbol);
  const coin = fromList ?? known ?? { symbol, pair: `${symbol}${S.app.cfg.data.quote ?? "USDT"}` };
  S.sel = { symbol, coin: { ...coin, name: known?.name ?? coin.name } };
  S.preview = null; S.message = null;
  renderResults();
  renderPreview();
  const want = S.sel;
  try {
    const feed = S.app.feed;
    const need = daysNeeded(S.app.cfg);
    const [daily, hourly, ticker] = await Promise.all([
      feed.klines(coin.pair, "1d", Math.min(need + 1, 1000)),
      feed.klines(coin.pair, "1h", 168),
      feed._get("/api/v3/ticker/24hr", { symbol: coin.pair }).catch(() => null),
    ]);
    if (S.sel !== want) return;                      // another coin was picked meanwhile
    const now = Date.now();
    const closed = daily.filter((k) => k.closeTime < now);
    const sigCfg = S.app.cfg.signal;
    S.preview = {
      hourly, last: daily.at(-1)?.close ?? null,
      ticker: ticker && { last: +ticker.lastPrice, changePct: +ticker.priceChangePercent, quoteVolume: +ticker.quoteVolume },
      days: closed.length, full: daily.length >= Math.min(need + 1, 1000), firstTime: daily[0]?.time + DAY_MS,
      signal: evaluate(daily, sigCfg, null),
      backtest: runAsset(closed, sigCfg, btSettings(S.app.cfg)),
    };
  } catch (e) {
    if (S.sel !== want) return;
    S.preview = { error: e.status === 400 ? `${coin.pair} is not traded on Binance.` : `Could not load ${coin.symbol}: ${e.message}` };
  }
  renderPreview();
}

async function onClick(e) {
  const pick = e.target.closest("[data-pick]");
  if (pick) { select(pick.dataset.pick); return; }
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled) return;
  const act = b.dataset.act, c = S.sel?.coin;
  if (!c) return;
  const sym = c.symbol;
  if (act === "open") { finish(`#/asset/${encodeURIComponent(sym)}`, false); return; }
  if (act === "add-local") { coins.addLocal(c); finish(`#/asset/${encodeURIComponent(sym)}`); return; }
  if (act === "remove-local") {
    if (!confirm(`Remove ${sym} from your view?`)) return;
    coins.removeLocal(sym); finish("#/"); return;
  }
  if (act === "add-shared" || act === "remove-shared") {
    const adding = act === "add-shared";
    if (!adding && !confirm(`Remove ${sym} for everyone? It leaves the dashboard and the daily Telegram report, and its price targets are deleted.`)) return;
    S.busy = true; S.message = { kind: "info", html: "Saving to GitHub…" }; renderActions();
    try {
      const who = S.who?.login ? ` by ${S.who.login}` : "";
      await coins.changeShared(S.app.cfg, S.token,
        (cfg) => (adding ? coins.withCoin(cfg, c) : coins.withoutCoin(cfg, sym)),
        `${adding ? "Add" : "Remove"} ${sym} from the dashboard${who}`);
      coins.removeLocal(sym);                         // now shared: no need to keep it in this browser's list
      S.busy = false;
      finish(adding ? `#/asset/${encodeURIComponent(sym)}` : "#/");
    } catch (err) {
      S.busy = false;
      const why = err.status === 401 || err.status === 403 ? "GitHub refused the token (expired, or no write permission)." : err.message;
      S.message = { kind: "error", html: `Not saved: ${esc(why)}` };
      renderActions();
    }
  }
}

// Coin list changes restart the page so the live feed follows the new list.
function finish(hash, reload = true) {
  location.hash = hash;
  if (reload) location.reload(); else close();
}
