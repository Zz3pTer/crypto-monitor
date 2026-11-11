// Dashboard entry point: loads config and official signals, starts the live
// feed, and repaints at the chosen refresh interval (spec 3, 4.2, 5.2).
import { loadConfig, enabledSymbols, ConfigError } from "./config.js";
import { evaluate } from "./signals.js";
import { Feed } from "./data-source.js";
import * as store from "./store.js";
import * as theme from "./theme.js";
import * as fmt from "./format.js";
import * as ov from "./ui-overview.js";
import { DetailView } from "./ui-detail.js";

const $ = (id) => document.getElementById(id);
const SIGNALS_URL = "data/signals.json";
const SIGNALS_RELOAD_MS = 5 * 60_000;
const HISTORY_RELOAD_MS = 15 * 60_000;

const S = {
  cfg: null,
  coins: [],
  feed: null,
  official: null,          // contents of data/signals.json, or null
  officialLoadedAt: 0,
  officialMissing: false,
  historyLoadedAt: 0,
  loaded: false,
  intervalSec: 30,
  effectiveSec: 30,
  paused: false,
  remaining: 0,
  lastPaint: null,
  filter: "ALL",
  sort: "score",
  search: "",
  prevPrices: new Map(),
  pollAdjusted: null,
  detail: null,            // DetailView while #/asset/<SYM> is open
};

// ---------- banners ----------

const banners = new Map();
function setBanner(id, kind, text) {
  if (text) banners.set(id, { kind, text }); else banners.delete(id);
  $("banners").innerHTML = [...banners.values()].map((b) => `<div class="banner ${b.kind}">${fmt.escape(b.text)}</div>`).join("");
}

// ---------- official signals ----------

async function loadOfficial() {
  try {
    const res = await fetch(`${SIGNALS_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (res.status === 404) { S.official = null; S.officialMissing = true; return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    S.official = await res.json();
    S.officialMissing = false;
  } catch {
    /* keep the last copy; the stale banner covers a long outage */
  } finally {
    S.officialLoadedAt = Date.now();
  }
}

function officialBanner() {
  if (S.officialMissing) {
    setBanner("official", "info", "Official signals appear after the first daily run. Until then, cards show the provisional signal from today's open candle.");
    return;
  }
  const gen = S.official?.generated_at ? new Date(S.official.generated_at) : null;
  const limitH = S.cfg.data.official_stale_hours ?? 26;
  if (gen && Date.now() - gen.getTime() > limitH * 3_600_000) {
    setBanner("official", "warn", `Official signals not updated since ${fmt.dateTime(gen)} — check the daily job.`);
  } else {
    setBanner("official", null, null);
  }
  $("footer-official").textContent = gen ? `Official signals: ${fmt.dateTime(gen)}.` : "";
}

// ---------- model ----------

function models() {
  const sig = S.cfg.signal;
  const officialBySym = new Map((S.official?.assets ?? []).map((a) => [a.symbol, a]));
  const staleMs = (S.cfg.data.stale_after_intervals ?? 3) * S.effectiveSec * 1000;
  const now = Date.now();
  return S.coins.map((c) => {
    const a = S.feed.assets.get(c.symbol);
    const off = officialBySym.get(c.symbol);
    const okOff = off && off.status === "ok" ? off : null;
    const live = a.daily.length ? evaluate(a.daily, sig, okOff?.signal ?? null) : null;
    const okLive = live && live.status === "ok" ? live : null;
    const shown = okOff ?? okLive;
    return {
      symbol: c.symbol, name: c.name, pair: c.pair,
      unavailable: a.unavailable,
      ticker: a.ticker,
      hourly: a.hourly,
      livePrice: a.ticker?.last ?? a.daily.at(-1)?.close ?? null,
      official: okOff,
      live: okLive,
      signal: shown?.signal ?? null,
      strong: shown?.strong ?? false,
      score: shown?.score ?? null,
      source: okOff ? "official" : okLive ? "provisional" : live?.status === "insufficient_history" ? "insufficient" : null,
      liveDiffers: Boolean(okOff && okLive && okLive.signal !== okOff.signal),
      stale: a.lastUpdate > 0 && now - a.lastUpdate > staleMs,
    };
  });
}

function nextReportText() {
  const [hh, mm] = S.cfg.telegram.report_time.split(":").map(Number);
  const now = fmt.mytFields();
  const at = `${S.cfg.telegram.report_time} MYT`;
  if (now.hh * 60 + now.mm < hh * 60 + mm) return `Today ${at}`;
  const gen = S.official?.generated_at ? fmt.mytFields(new Date(S.official.generated_at)).iso : null;
  return gen === now.iso ? `Tomorrow ${at}` : `Due now (${at})`;
}

function feedStatus() {
  const f = S.feed;
  if (f.mode === "live") return { cls: "live", text: `Exchange WebSocket · connected${f.latencyMs != null ? ` · latency ${f.latencyMs} ms` : ""}` };
  if (f.mode === "polling") return { cls: "polling", text: `Polling every ${f.pollSec ?? S.effectiveSec} s · WebSocket retrying` };
  if (f.mode === "down") return { cls: "down", text: "Disconnected — retrying" };
  return { cls: "", text: "Connecting…" };
}

// ---------- painting ----------

function paint() {
  S.lastPaint = new Date();
  if (detailSymbol()) { paintDetail(); updateStatus(); return; }
  if (S.detail) { S.detail.destroy(); S.detail = null; $("view").innerHTML = ""; }
  const all = models();
  const counts = { BUY: 0, HOLD: 0, SELL: 0 };
  for (const m of all) if (m.signal) counts[m.signal]++;

  const q = S.search.trim().toUpperCase();
  let shown = all.filter((m) => (S.filter === "ALL" || m.signal === S.filter) &&
    (!q || m.symbol.includes(q) || m.name.toUpperCase().includes(q)));
  const by = {
    score: (a, b) => (b.score ?? -999) - (a.score ?? -999),
    change: (a, b) => (b.ticker?.changePct ?? -999) - (a.ticker?.changePct ?? -999),
    name: (a, b) => a.symbol.localeCompare(b.symbol),
  }[S.sort];
  shown = shown.sort(by);

  // Prices flash green or red briefly when they move (FR-UI-10).
  const flashes = new Map();
  for (const m of all) {
    const prev = S.prevPrices.get(m.symbol);
    if (prev != null && m.livePrice != null && m.livePrice !== prev) flashes.set(m.symbol, m.livePrice > prev ? "up" : "down");
    if (m.livePrice != null) S.prevPrices.set(m.symbol, m.livePrice);
  }

  const view = $("view");
  if (!view.querySelector("#grid")) mountOverview();
  if (!S.loaded) {
    ov.renderSkeleton(view, S.coins.length);
  } else {
    ov.renderCards(view, shown, S.cfg.signal.thresholds, flashes);
    if (flashes.size) setTimeout(() => view.querySelectorAll(".price.flash-up, .price.flash-down")
      .forEach((el) => el.classList.remove("flash-up", "flash-down")), 900);
  }
  ov.renderSummary(view, { counts, total: all.length, filter: S.filter, sort: S.sort, nextReport: nextReportText(), feed: feedStatus() });
  updateStatus();
}

function detailSymbol() {
  return location.hash.startsWith("#/asset/") ? decodeURIComponent(location.hash.slice("#/asset/".length)).toUpperCase() : null;
}

function paintDetail() {
  const sym = detailSymbol();
  const coin = S.coins.find((c) => c.symbol === sym);
  if (!coin) {
    S.detail?.destroy();
    S.detail = null;
    $("view").innerHTML = `<div class="placeholder"><p><a href="#/">‹ Back</a></p>
      <h2>${fmt.escape(sym)} is not in the coin list</h2><p>Add it in the settings, or check the address.</p></div>`;
    return;
  }
  if (!S.loaded) return;
  if (!S.detail || S.detail.ctx.coin.symbol !== sym) {
    S.detail?.destroy();
    S.detail = new DetailView($("view"), {
      cfg: S.cfg, feed: S.feed, coin,
      getModel: () => models().find((x) => x.symbol === coin.symbol),
      getOfficial: () => S.official,
    });
  }
  S.detail.update();
}

function mountOverview() {
  ov.mountOverview($("view"), {
    onFilter: (f) => { S.filter = S.filter === f && f !== "ALL" ? "ALL" : f; store.set("filter", S.filter); paint(); },
    onSort: (s) => { S.sort = s; store.set("sort", s); paint(); },
    onSearch: (q) => { S.search = q; paint(); },
    onOpen: (sym) => { location.hash = `#/asset/${encodeURIComponent(sym)}`; },
  });
  $("search").value = S.search;
}

function updateStatus() {
  const f = S.feed;
  const dot = $("status-dot"), txt = $("status-text");
  dot.className = `dot ${f ? { live: "live", polling: "polling", down: "down" }[f.mode] ?? "" : ""}`;
  txt.className = `state ${dot.className.replace("dot", "").trim()}`;
  txt.textContent = !f ? "Loading…" : { live: "LIVE", polling: "POLLING", down: "OFFLINE", connecting: "Connecting…" }[f.mode];
  const last = S.lastPaint ? `Last update ${fmt.clock(S.lastPaint)}` : "";
  const next = S.paused ? " · paused" : S.loaded ? ` · next in ${S.remaining} s` : "";
  $("last-update").textContent = last + next;
  if (f?.mode === "down") setBanner("feed", "error", "Live data disconnected — retrying. Last values stay on screen, tagged stale.");
  else setBanner("feed", null, null);
  if (f?.mode === "polling" && S.pollAdjusted) {
    setBanner("poll", "warn", `Live stream unavailable: polling every ${S.pollAdjusted} s, the fastest allowed by the data provider.`);
  } else {
    setBanner("poll", null, null);
  }
}

// ---------- refresh control (spec 4.2) ----------

function computeEffective() {
  const slowHidden = store.get("slowHidden", true);
  const hidden = document.hidden && slowHidden;
  S.effectiveSec = hidden ? Math.max(S.intervalSec, S.cfg.refresh.hidden_tab_sec ?? 300) : S.intervalSec;
  const poll = S.feed.setPollInterval(S.effectiveSec);
  S.pollAdjusted = poll > S.effectiveSec ? poll : null;
  if (S.pollAdjusted) S.effectiveSec = poll;
}

async function refreshNow() {
  const jobs = [];
  if (Date.now() - S.officialLoadedAt > SIGNALS_RELOAD_MS) jobs.push(loadOfficial().then(officialBanner));
  if (Date.now() - S.historyLoadedAt > HISTORY_RELOAD_MS) jobs.push(S.feed.loadHistory().then(() => { S.historyLoadedAt = Date.now(); }));
  if (S.feed.mode !== "live") jobs.push(S.feed.loadTickers().catch(() => {}));
  await Promise.all(jobs);
  paint();
  S.remaining = S.effectiveSec;
}

function setupHeader() {
  const sel = $("refresh-select");
  const label = (s) => (s < 60 ? `${s} s` : `${s / 60} min`);
  sel.innerHTML = S.cfg.refresh.options_sec.map((s) => `<option value="${s}">${label(s)}</option>`).join("");
  sel.value = String(S.intervalSec);
  sel.addEventListener("change", () => {
    S.intervalSec = Number(sel.value);
    store.set("refreshSec", S.intervalSec);
    computeEffective();
    S.remaining = S.effectiveSec;
    updateStatus();
  });

  const pause = $("pause-btn");
  const showPause = () => {
    pause.setAttribute("aria-pressed", String(S.paused));
    pause.innerHTML = S.paused ? "▶ Resume" : "❚❚ Pause";
  };
  showPause();
  pause.addEventListener("click", () => { S.paused = !S.paused; store.set("paused", S.paused); showPause(); updateStatus(); });

  $("refresh-btn").addEventListener("click", () => { S.officialLoadedAt = 0; refreshNow(); });

  $("settings-btn").addEventListener("click", () => {
    setBanner("settings", "info", "The settings panel (all settings, saved to GitHub) is being built.");
    setTimeout(() => setBanner("settings", null, null), 4000);
  });

  const header = $("header"), toggle = $("menu-toggle");
  toggle.addEventListener("click", () => {
    const open = !header.classList.contains("open");
    header.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
}

// ---------- start ----------

async function main() {
  try {
    S.cfg = await loadConfig();
  } catch (e) {
    setBanner("config", "error", e instanceof ConfigError ? e.message : `Could not start: ${e.message}`);
    $("status-text").textContent = "Error";
    return;
  }
  theme.init(S.cfg);
  theme.onChange(() => S.detail?.applyTheme());
  S.coins = enabledSymbols(S.cfg);
  const opts = S.cfg.refresh.options_sec;
  const savedSec = store.get("refreshSec");
  S.intervalSec = opts.includes(savedSec) ? savedSec : S.cfg.refresh.default_sec;
  S.paused = store.get("paused", false) === true;
  S.filter = store.get("filter", "ALL");
  S.sort = store.get("sort", "score");

  // A change of connection state shows at once in the header and the Data feed tile.
  S.feed = new Feed(S.cfg, S.coins, () => {
    updateStatus();
    const view = $("view");
    if (S.loaded && view.querySelector("#feed")) view.querySelector("#feed").innerHTML =
      `<span class="dot ${feedStatus().cls}"></span><span>${fmt.escape(feedStatus().text)}</span>`;
  });
  computeEffective();
  setupHeader();
  paint();                                            // grey placeholder cards (spec 5.6)

  await Promise.all([loadOfficial().then(officialBanner), S.feed.loadHistory(), S.feed.loadTickers().catch(() => {})]);
  S.historyLoadedAt = Date.now();
  S.loaded = true;
  S.feed.start();
  paint();
  S.remaining = S.effectiveSec;

  setInterval(() => {
    if (!S.paused) {
      S.remaining -= 1;
      if (S.remaining <= 0) { refreshNow(); S.remaining = S.effectiveSec; }
    }
    updateStatus();
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    computeEffective();
    if (!document.hidden) refreshNow();               // catch up as soon as the tab is visible again
  });
  window.addEventListener("hashchange", () => { window.scrollTo(0, 0); paint(); });
}

main();
