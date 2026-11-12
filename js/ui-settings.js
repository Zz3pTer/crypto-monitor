// Settings panel (spec 5.5, extended at the owner's request): slides in from
// the right.
//   "This browser":     refresh, slow-down when hidden, visible coins and order.
//                       Saved in this browser only.
//   "Shared settings":  everything in config/config.json. "Save to GitHub"
//                       needs a token that may write to the repository;
//                       without one, changes can be tried in this browser only.
//   "Advanced":         the same settings as raw JSON.
import * as store from "./store.js";
import * as fmt from "./format.js";
import { validate } from "./config.js";
import * as gh from "./github.js";
import { viewCoins, removeLocal } from "./coins.js";

const esc = fmt.escape;
const LOCAL_KEYS = ["refreshSec", "slowHidden", "coinOrder", "hiddenCoins", "overlays", "filter", "sort", "detailTf", "paused"];
const WEIGHT_LABELS = { trend: "Trend (price vs SMA 200)", cross: "SMA 50 vs SMA 200", macd: "MACD", rsi: "RSI", bollinger: "Bollinger", momentum: "Momentum ROC", volume: "Volume" };
const PERIOD_LABELS = { sma_fast: "SMA fast", sma_slow: "SMA slow", ema: "EMA", rsi: "RSI", bb: "Bollinger length", bb_std: "Bollinger width (std)",
  macd_fast: "MACD fast", macd_slow: "MACD slow", macd_signal: "MACD signal", roc: "Momentum ROC", vol_avg: "Volume average" };

let el = null, lastFocus = null;
let S = null;   // panel state

export function open(app) {
  // app: { cfg, baseCfg, overrideActive, onLocalChange(), onTryLocally(cfg), onDiscardLocal(), refreshSec }
  lastFocus = document.activeElement;
  S = { app, tab: "browser", draft: structuredClone(app.cfg), dirty: false, message: null, busy: false, token: gh.getToken(), who: null };
  if (!el) build();
  el.hidden = false;
  document.body.classList.add("no-scroll");
  requestAnimationFrame(() => el.classList.add("open"));
  render();
  el.querySelector(".set-close").focus();
  if (S.token) verifyToken(S.token, true);
}

export function close() {
  if (!el || el.hidden) return;
  if (S.dirty && !confirm("Discard your unsaved changes to the shared settings?")) return;
  el.classList.remove("open");
  document.body.classList.remove("no-scroll");
  setTimeout(() => { el.hidden = true; }, 200);
  lastFocus?.focus?.();
}

function build() {
  el = document.createElement("div");
  el.className = "set-wrap";
  el.hidden = true;
  el.innerHTML = `<div class="set-backdrop"></div>
    <aside class="set-panel" role="dialog" aria-modal="true" aria-labelledby="set-title">
      <header class="set-head"><h2 id="set-title">Settings</h2><button class="btn set-close" aria-label="Close settings">✕</button></header>
      <div class="tabs set-tabs" role="tablist">
        <button class="tab" role="tab" data-stab="browser">This browser</button>
        <button class="tab" role="tab" data-stab="shared">Shared settings</button>
        <button class="tab" role="tab" data-stab="json">Advanced</button>
      </div>
      <div class="set-body" id="set-body"></div>
      <footer class="set-foot" id="set-foot"></footer>
    </aside>`;
  document.body.append(el);
  el.querySelector(".set-backdrop").addEventListener("click", close);
  el.querySelector(".set-close").addEventListener("click", close);
  el.querySelectorAll("[data-stab]").forEach((b) => b.addEventListener("click", () => { readForm(); S.tab = b.dataset.stab; render(); }));
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
    if (e.key === "Tab") trapFocus(e);
  });
  el.addEventListener("input", onInput);
  el.addEventListener("change", onInput);
  el.addEventListener("click", onClick);
}

function trapFocus(e) {
  const f = [...el.querySelectorAll("button, input, select, textarea, a[href]")].filter((x) => !x.disabled && x.offsetParent !== null);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
}

// ---------- rendering ----------

function render() {
  el.querySelectorAll("[data-stab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.stab === S.tab)));
  const body = el.querySelector("#set-body");
  body.innerHTML = S.tab === "browser" ? browserTab() : S.tab === "shared" ? sharedTab() : jsonTab();
  el.querySelector("#set-foot").innerHTML = S.tab === "browser" ? browserFoot() : sharedFoot();
  if (S.tab !== "browser") showProblems();
}

function browserTab() {
  const cfg = S.app.cfg;
  const label = (s) => (s < 60 ? `${s} s` : `${s / 60} min`);
  const order = orderedCoins(cfg);
  const hidden = new Set(store.get("hiddenCoins", []));
  return `
    <p class="muted">These settings apply to this browser only.</p>
    <label class="field"><span>Refresh interval</span>
      <select class="btn" data-local="refreshSec">${cfg.refresh.options_sec.map((s) => `<option value="${s}" ${s === S.app.refreshSec ? "selected" : ""}>${label(s)}</option>`).join("")}</select></label>
    <label class="field check"><input type="checkbox" data-local="slowHidden" ${store.get("slowHidden", true) ? "checked" : ""}>
      <span>Slow down when the tab is hidden (refresh every ${label(cfg.refresh.hidden_tab_sec ?? 300)})</span></label>
    <h3>Visible coins and order</h3>
    <p class="muted">Tick to show; drag, or use the arrows, to change the order. <button class="btn mini" data-act="search-coin">+ Add coin</button></p>
    <ol class="coin-order" id="coin-order">${order.map((c, i) => `
      <li draggable="true" data-sym="${esc(c.symbol)}">
        <span class="grip" aria-hidden="true">☰</span>
        <label><input type="checkbox" data-show="${esc(c.symbol)}" ${hidden.has(c.symbol) ? "" : "checked"}> <b>${esc(c.symbol)}</b> <span class="muted">${esc(c.name)}</span>${c.local ? ` <span class="tag" title="Not in the Telegram report">my view</span>` : ""}</label>
        <span class="arrows"><button class="btn mini" data-move="-1" data-sym="${esc(c.symbol)}" aria-label="Move ${esc(c.symbol)} up" ${i === 0 ? "disabled" : ""}>↑</button><button class="btn mini" data-move="1" data-sym="${esc(c.symbol)}" aria-label="Move ${esc(c.symbol)} down" ${i === order.length - 1 ? "disabled" : ""}>↓</button>${c.local ? `<button class="btn mini" data-act="remove-local" data-sym="${esc(c.symbol)}" aria-label="Remove ${esc(c.symbol)} from my view">✕</button>` : ""}</span>
      </li>`).join("")}</ol>
    <h3>Signal rules in use</h3>
    <p class="muted">Weights ${Object.entries(cfg.signal.weights).map(([k, v]) => `${esc(WEIGHT_LABELS[k] ?? k)} ${v}`).join(" · ")}.
      BUY at +${cfg.signal.thresholds.buy}, SELL at ${cfg.signal.thresholds.sell}. Change them under Shared settings.</p>`;
}

function browserFoot() {
  return `<button class="btn" data-act="reset-local">Reset this browser to defaults</button>`;
}

const num = (path, value, attrs = "") => `<input class="btn num-in" type="number" data-path="${path}" value="${esc(value ?? "")}" ${attrs}>`;

function sharedTab() {
  const d = S.draft, sig = d.signal;
  const coinOpts = (sel) => d.symbols.map((c) => `<option ${c.symbol === sel ? "selected" : ""}>${esc(c.symbol)}</option>`).join("");
  const wsum = Object.values(sig.weights).reduce((a, b) => a + (Number(b) || 0), 0);
  return `
    ${S.app.overrideActive ? `<div class="banner warn">This browser is using settings that are not saved to GitHub. <button class="btn mini" data-act="discard-local">Go back to the saved settings</button></div>` : ""}
    <details open><summary>Coins</summary>
      <div class="table-wrap"><table class="edit">
        <thead><tr><th>Symbol</th><th>Name</th><th>Binance pair</th><th>CoinGecko ID</th><th>On</th><th></th></tr></thead>
        <tbody>${d.symbols.map((c, i) => `<tr>
          <td><input class="btn" data-path="symbols.${i}.symbol" value="${esc(c.symbol)}" size="6" aria-label="Symbol"></td>
          <td><input class="btn" data-path="symbols.${i}.name" value="${esc(c.name)}" size="10" aria-label="Name"></td>
          <td><input class="btn" data-path="symbols.${i}.pair" value="${esc(c.pair)}" size="10" aria-label="Binance pair"></td>
          <td><input class="btn" data-path="symbols.${i}.coingecko_id" value="${esc(c.coingecko_id ?? "")}" size="10" aria-label="CoinGecko ID"></td>
          <td><input type="checkbox" data-path="symbols.${i}.enabled" ${c.enabled !== false ? "checked" : ""} aria-label="Enabled"></td>
          <td><button class="btn mini" data-act="del-coin" data-i="${i}" aria-label="Remove ${esc(c.symbol)}">✕</button></td></tr>`).join("")}</tbody>
      </table></div>
      <button class="btn primary" data-act="search-coin">Search and add a coin</button> <button class="btn" data-act="add-coin">+ Add a row by hand</button>
      <p class="muted">The pair must exist on Binance (e.g. DOGEUSDT). A new coin shows its live price at once; its official signal and the Telegram report include it from the next daily run.</p>
    </details>

    <details open><summary>Telegram report and alerts</summary>
      <label class="field"><span>Daily report time (MYT)</span><input class="btn" type="time" data-path="telegram.report_time" value="${esc(d.telegram.report_time)}"></label>
      <p class="muted">Sent on the first run after this time; the job runs every 15 minutes.</p>
      <label class="field"><span>Check price targets</span><select class="btn" data-path="alerts.check">
        <option value="daily" ${d.alerts.check === "daily" ? "selected" : ""}>Once a day, on the daily close (in the report)</option>
        <option value="intraday" ${d.alerts.check === "intraday" ? "selected" : ""}>Every 15 minutes (separate message)</option></select></label>
      <label class="field check"><input type="checkbox" data-path="alerts.signal_change" ${d.alerts.signal_change ? "checked" : ""}><span>Message when a coin's live signal changes during the day</span></label>
      <h4>Price targets</h4>
      <div class="table-wrap"><table class="edit">
        <thead><tr><th>Coin</th><th>When price is</th><th>Price (USD)</th><th></th></tr></thead>
        <tbody>${(d.alerts.targets ?? []).map((t, i) => {
          const side = "below" in t ? "below" : "above";
          return `<tr><td><select class="btn" data-path="alerts.targets.${i}.symbol">${coinOpts(t.symbol)}</select></td>
            <td><select class="btn" data-target-side="${i}"><option value="above" ${side === "above" ? "selected" : ""}>at or above</option><option value="below" ${side === "below" ? "selected" : ""}>at or below</option></select></td>
            <td>${num(`alerts.targets.${i}.${side}`, t[side], 'step="any" min="0"')}</td>
            <td><button class="btn mini" data-act="del-target" data-i="${i}" aria-label="Remove target">✕</button></td></tr>`;
        }).join("") || `<tr><td colspan="4" class="muted">No price targets.</td></tr>`}</tbody>
      </table></div>
      <button class="btn" data-act="add-target">+ Add price target</button>
      <label class="field"><span>Dashboard link in messages</span><input class="btn wide" data-path="telegram.dashboard_url" value="${esc(d.telegram.dashboard_url)}"></label>
    </details>

    <details><summary>Refresh and display</summary>
      <label class="field"><span>Refresh choices (seconds, comma-separated)</span><input class="btn wide" data-list="refresh.options_sec" value="${esc(d.refresh.options_sec.join(", "))}"></label>
      <label class="field"><span>Default refresh (seconds)</span>${num("refresh.default_sec", d.refresh.default_sec, 'min="1"')}</label>
      <label class="field"><span>Refresh when the tab is hidden (seconds)</span>${num("refresh.hidden_tab_sec", d.refresh.hidden_tab_sec, 'min="1"')}</label>
      <label class="field"><span>Fastest polling when the live stream is down (seconds)</span>${num("refresh.polling_min_sec", d.refresh.polling_min_sec, 'min="1"')}</label>
      <label class="field"><span>Starting theme</span><select class="btn" data-path="theme.default">
        <option value="dark" ${d.theme.default === "dark" ? "selected" : ""}>Dark</option><option value="bright" ${d.theme.default === "bright" ? "selected" : ""}>Bright</option></select></label>
    </details>

    <details><summary>Signal rules</summary>
      <h4>Weights <span class="muted" id="wsum">(total ${wsum}; must be 100)</span></h4>
      <div class="grid2">${Object.entries(sig.weights).map(([k, v]) => `<label class="field"><span>${esc(WEIGHT_LABELS[k] ?? k)}</span>${num(`signal.weights.${k}`, v, 'min="0"')}</label>`).join("")}</div>
      <h4>Thresholds</h4>
      <div class="grid2">
        <label class="field"><span>Strong BUY at or above</span>${num("signal.thresholds.strong_buy", sig.thresholds.strong_buy)}</label>
        <label class="field"><span>BUY at or above</span>${num("signal.thresholds.buy", sig.thresholds.buy)}</label>
        <label class="field"><span>SELL at or below</span>${num("signal.thresholds.sell", sig.thresholds.sell)}</label>
        <label class="field"><span>Strong SELL at or below</span>${num("signal.thresholds.strong_sell", sig.thresholds.strong_sell)}</label>
        <label class="field"><span>Anti-flip buffer (points)</span>${num("signal.hysteresis", sig.hysteresis, 'min="0"')}</label>
        <label class="field"><span>RSI oversold below</span>${num("signal.rsi_oversold", sig.rsi_oversold)}</label>
        <label class="field"><span>RSI overbought above</span>${num("signal.rsi_overbought", sig.rsi_overbought)}</label>
        <label class="field"><span>Momentum threshold (%)</span>${num("signal.roc_pct", sig.roc_pct, 'step="any"')}</label>
        <label class="field"><span>Volume spike (× average)</span>${num("signal.volume_spike", sig.volume_spike, 'step="any"')}</label>
        <label class="field"><span>Minimum daily candles</span>${num("signal.min_candles", sig.min_candles)}</label>
      </div>
      <h4>Indicator periods (days)</h4>
      <div class="grid2">${Object.entries(sig.periods).map(([k, v]) => `<label class="field"><span>${esc(PERIOD_LABELS[k] ?? k)}</span>${num(`signal.periods.${k}`, v, 'step="any" min="0"')}</label>`).join("")}</div>
      <p class="muted">Changing the rules changes every signal from the next daily run. The tests on GitHub keep checking the engine against its own saved test data, so they are not affected.</p>
    </details>

    <details><summary>Data</summary>
      <div class="grid2">
        <label class="field"><span>Daily candles downloaded</span>${num("data.lookback_days", d.data.lookback_days)}</label>
        <label class="field"><span>Days of history kept</span>${num("data.history_keep_days", d.data.history_keep_days)}</label>
        <label class="field"><span>Stale after (refresh intervals)</span>${num("data.stale_after_intervals", d.data.stale_after_intervals)}</label>
        <label class="field"><span>Warn if official signals older than (hours)</span>${num("data.official_stale_hours", d.data.official_stale_hours)}</label>
      </div>
    </details>

    <details><summary>Backtest</summary>
      <div class="grid2">
        <label class="field"><span>Years replayed</span>${num("backtest.years", d.backtest?.years ?? 2, 'step="0.5" min="0.5" max="10"')}</label>
        <label class="field"><span>Fee per trade (%)</span>${num("backtest.fee_pct", d.backtest?.fee_pct ?? 0.1, 'step="any" min="0"')}</label>
      </div>
      <label class="field"><span>Check BUY/SELL after (days, comma-separated)</span><input class="btn wide" data-list="backtest.horizons_days" value="${esc((d.backtest?.horizons_days ?? [7, 30]).join(", "))}"></label>
      <p class="muted">The backtest runs every Sunday at 09:00 MYT, or by hand from the Actions tab on GitHub.</p>
    </details>
    ${tokenBlock()}`;
}

function jsonTab() {
  return `<p class="muted">The complete shared settings as JSON. Edit, then use the buttons below.</p>
    <textarea class="json" id="json-edit" spellcheck="false" aria-label="Settings JSON">${esc(gh.formatConfig(S.draft))}</textarea>
    ${tokenBlock()}`;
}

function tokenBlock() {
  const { owner, repo } = gh.repoInfo(S.app.cfg);
  if (S.token && S.who?.ok) {
    return `<div class="token ok">Saving to GitHub as <b>${esc(S.who.login ?? "authorised user")}</b>. <button class="btn mini" data-act="forget-token">Forget token on this device</button></div>`;
  }
  return `<div class="token">
      <b>Saving to GitHub needs a token.</b> Only people the owner has given a token can save.
      <div class="token-row"><input class="btn wide" type="password" id="token-in" placeholder="Paste GitHub token" autocomplete="off" aria-label="GitHub token">
      <button class="btn" data-act="use-token">Connect</button></div>
      ${S.who && !S.who.ok ? `<div class="err">${esc(S.who.reason)}</div>` : ""}
      <details class="howto"><summary>How to get a token</summary>
        The repository owner creates it at GitHub → Settings → Developer settings → Fine-grained tokens:
        repository access <b>${esc(owner)}/${esc(repo)}</b> only, permission <b>Contents: Read and write</b>, with an expiry date.
        It is kept in this browser only. Use “Forget token” on shared computers.</details>
    </div>`;
}

function sharedFoot() {
  const canSave = S.token && S.who?.ok;
  return `<div class="problems" id="problems" aria-live="polite"></div>
    ${S.message ? `<div class="set-msg ${S.message.kind}">${S.message.html}</div>` : ""}
    <div class="set-actions">
      <button class="btn" data-act="revert" ${S.dirty ? "" : "disabled"}>Undo changes</button>
      <button class="btn" data-act="try" ${S.dirty ? "" : "disabled"}>Try in this browser</button>
      <button class="btn primary" data-act="save" ${canSave && !S.busy ? "" : "disabled"} title="${canSave ? "" : "Connect a GitHub token first"}">${S.busy ? "Saving…" : "Save to GitHub"}</button>
    </div>`;
}

function showProblems() {
  const box = el.querySelector("#problems");
  if (!box) return;
  const probs = S.jsonError ? [S.jsonError] : validate(S.draft);
  box.innerHTML = probs.length ? `<b>Fix before saving:</b><ul>${probs.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : "";
  el.querySelectorAll('[data-act="save"], [data-act="try"]').forEach((b) => { if (probs.length) b.disabled = true; });
  const wsum = el.querySelector("#wsum");
  if (wsum) wsum.textContent = `(total ${Object.values(S.draft.signal.weights).reduce((a, b) => a + (Number(b) || 0), 0)}; must be 100)`;
}

// ---------- editing ----------

function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = (o[/^\d+$/.test(k) ? Number(k) : k] ??= {});
  o[keys.at(-1)] = value;
}

function readForm() {
  if (S.tab === "json") {
    const ta = el.querySelector("#json-edit");
    if (!ta) return;
    try {
      const parsed = JSON.parse(ta.value);
      S.draft = parsed;
      S.jsonError = null;
    } catch (e) {
      S.jsonError = `The JSON is not valid: ${e.message}`;
    }
  }
}

function onInput(e) {
  const t = e.target;
  if (t.dataset.local === "refreshSec" && e.type === "change") { store.set("refreshSec", Number(t.value)); S.app.onLocalChange(); return; }
  if (t.dataset.local === "slowHidden") { store.set("slowHidden", t.checked); S.app.onLocalChange(); return; }
  if (t.dataset.show && e.type === "change") {
    const hidden = new Set(store.get("hiddenCoins", []));
    if (t.checked) hidden.delete(t.dataset.show); else hidden.add(t.dataset.show);
    store.set("hiddenCoins", [...hidden]);
    S.app.onLocalChange();
    return;
  }
  if (t.id === "json-edit") { readForm(); S.dirty = true; showProblems(); refreshFootButtons(); return; }
  if (t.dataset.path) {
    let v;
    if (t.type === "checkbox") v = t.checked;
    else if (t.type === "number") v = t.value === "" ? null : Number(t.value);
    else v = t.value;
    setPath(S.draft, t.dataset.path, v);
  } else if (t.dataset.list) {
    setPath(S.draft, t.dataset.list, t.value.split(/[\s,]+/).filter(Boolean).map(Number));
  } else if (t.dataset.targetSide !== undefined && e.type === "change") {
    const tg = S.draft.alerts.targets[Number(t.dataset.targetSide)];
    const val = tg.above ?? tg.below;
    delete tg.above; delete tg.below;
    tg[t.value] = val;
    render();
  } else {
    return;
  }
  S.dirty = true;
  S.message = null;
  showProblems();
  refreshFootButtons();
}

function refreshFootButtons() {
  if (S.tab === "browser") return;
  const foot = el.querySelector("#set-foot");
  const keepProblems = foot.querySelector("#problems")?.innerHTML;
  foot.innerHTML = sharedFoot();
  if (keepProblems !== undefined) foot.querySelector("#problems").innerHTML = keepProblems;
  showProblems();
}

async function onClick(e) {
  const b = e.target.closest("button");
  if (!b || !el.contains(b)) return;
  const act = b.dataset.act;
  if (b.dataset.move) return moveCoin(b.dataset.sym, Number(b.dataset.move));
  if (!act) return;
  const d = S.draft;
  if (act === "add-coin") { d.symbols.push({ symbol: "", name: "", pair: "", coingecko_id: "", enabled: true }); S.dirty = true; render(); el.querySelector(`[data-path="symbols.${d.symbols.length - 1}.symbol"]`)?.focus(); }
  if (act === "del-coin") {
    const c = d.symbols[Number(b.dataset.i)];
    d.symbols.splice(Number(b.dataset.i), 1);
    d.alerts.targets = (d.alerts.targets ?? []).filter((t) => t.symbol !== c.symbol);
    S.dirty = true; render();
  }
  if (act === "add-target") { (d.alerts.targets ??= []).push({ symbol: d.symbols[0]?.symbol ?? "", above: 0 }); S.dirty = true; render(); }
  if (act === "del-target") { d.alerts.targets.splice(Number(b.dataset.i), 1); S.dirty = true; render(); }
  if (act === "revert") { S.draft = structuredClone(S.app.cfg); S.dirty = false; S.jsonError = null; S.message = null; render(); }
  if (act === "try") { readForm(); if (!validate(S.draft).length) { S.dirty = false; S.app.onTryLocally(S.draft); } }
  if (act === "discard-local") { S.dirty = false; S.app.onDiscardLocal(); }
  if (act === "use-token") { const v = el.querySelector("#token-in").value.trim(); if (v) await verifyToken(v, false); }
  if (act === "forget-token") { gh.setToken(null); S.token = null; S.who = null; render(); }
  if (act === "save") await save();
  if (act === "reset-local") {
    if (!confirm("Reset refresh, coin order and the other settings of this browser to the defaults?")) return;
    for (const k of LOCAL_KEYS) store.set(k, null);
    S.app.onLocalChange(true);
    render();
  }
  if (act === "reload") location.reload();
  if (act === "search-coin") {
    if (S.dirty && !confirm("Discard your unsaved changes to the shared settings?")) return;
    S.dirty = false; S.app.onAddCoin?.();
  }
  if (act === "remove-local") {
    if (!confirm(`Remove ${b.dataset.sym} from your view?`)) return;
    removeLocal(b.dataset.sym); location.reload();
  }
}

function moveCoin(sym, dir) {
  const order = orderedCoins(S.app.cfg).map((c) => c.symbol);
  const i = order.indexOf(sym), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  store.set("coinOrder", order);
  S.app.onLocalChange();
  render();
  el.querySelector(`[data-move="${dir}"][data-sym="${CSS.escape(sym)}"]`)?.focus();
}

// Drag and drop for the coin order.
let dragSym = null;
document.addEventListener("dragstart", (e) => { const li = e.target.closest?.(".coin-order li"); if (li) { dragSym = li.dataset.sym; e.dataTransfer.effectAllowed = "move"; } });
document.addEventListener("dragover", (e) => { if (dragSym && e.target.closest?.(".coin-order li")) e.preventDefault(); });
document.addEventListener("drop", (e) => {
  const li = e.target.closest?.(".coin-order li");
  if (!dragSym || !li) return;
  e.preventDefault();
  const order = orderedCoins(S.app.cfg).map((c) => c.symbol);
  const from = order.indexOf(dragSym), to = order.indexOf(li.dataset.sym);
  order.splice(to, 0, order.splice(from, 1)[0]);
  store.set("coinOrder", order);
  dragSym = null;
  S.app.onLocalChange();
  render();
});

export function orderedCoins(cfg) {
  const coins = viewCoins(cfg);
  const order = store.get("coinOrder", []);
  const rank = (s) => { const i = order.indexOf(s); return i < 0 ? 1e6 + coins.findIndex((c) => c.symbol === s) : i; };
  return [...coins].sort((a, b) => rank(a.symbol) - rank(b.symbol));
}

// ---------- GitHub ----------

async function verifyToken(token, silent) {
  try {
    S.who = await gh.checkToken(S.app.cfg, token);
  } catch (e) {
    S.who = { ok: false, reason: `Could not check the token: ${e.message}` };
  }
  if (S.who.ok) { gh.setToken(token); S.token = token; }
  else if (!silent) { S.token = null; }
  if (!el.hidden) render();
}

async function save() {
  readForm();
  const probs = validate(S.draft);
  if (probs.length || S.jsonError) return showProblems();
  S.busy = true; S.message = null; refreshFootButtons();
  try {
    const remote = await gh.readRemote(S.app.cfg, S.token);
    // Someone else saved since this page loaded: stop rather than overwrite their change.
    if (JSON.stringify(JSON.parse(remote.text)) !== JSON.stringify(S.app.baseCfg)) {
      S.message = { kind: "warn", html: `The settings on GitHub were changed since this page was opened. <button class="btn mini" data-act="reload">Reload</button> to get the latest, then make your change again.` };
      return;
    }
    const text = gh.formatConfig(S.draft) + "\n";
    const who = S.who?.login ? ` by ${S.who.login}` : "";
    const res = await gh.saveConfig(S.app.cfg, S.token, text, remote.sha, `Settings updated from the dashboard${who}`);
    S.dirty = false;
    S.app.onSaved?.(S.draft);
    S.message = { kind: "ok", html: `Saved (<a href="${esc(res.commitUrl)}" target="_blank" rel="noopener">see the change on GitHub</a>). The website updates in about a minute; the daily job uses the new settings from its next run. <button class="btn mini" data-act="reload">Reload page</button>` };
  } catch (e) {
    const why = e.status === 401 || e.status === 403 ? "GitHub refused the token (expired, or no write permission)." : e.status === 409 ? "Someone else saved at the same moment. Reload and try again." : e.message;
    S.message = { kind: "error", html: `Not saved: ${esc(why)}` };
  } finally {
    S.busy = false;
    render();
  }
}
